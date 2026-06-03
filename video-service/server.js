import express from 'express'
import ffmpeg from 'fluent-ffmpeg'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { GoogleAIFileManager } from '@google/generative-ai/server'
import ws from 'ws'
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const app = express()
app.use(express.json({ limit: '300mb' }))

const PORT = process.env.PORT || 3001

// Health check
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'aidoc-video' })
})

// Helper: create supabase client from request.
//
// `realtime: { transport: ws }` is required because supabase-js >= 2.100
// initializes a RealtimeClient on createClient() even when we don't
// subscribe to realtime channels — and on Node < 22 (this service runs
// on Node 20 in the Railway image) the SDK throws on boot if no
// WebSocket transport is provided. Service only uses storage upload /
// download; the transport is wired so the SDK's init-time check
// passes, not because realtime is actually used.
function getSupabase(body) {
  if (!body.supabaseUrl || !body.serviceKey) throw new Error('supabaseUrl and serviceKey required')
  return createClient(body.supabaseUrl, body.serviceKey, {
    realtime: { transport: ws },
  })
}

// Helper: download from supabase storage
async function downloadVideo(supabase, videoPath) {
  const { data, error } = await supabase.storage.from('artifacts').download(videoPath)
  if (error || !data) throw new Error(`Download failed: ${error?.message ?? 'no data'}`)
  return Buffer.from(await data.arrayBuffer())
}

// Helper: upload to supabase storage
async function uploadFile(supabase, path, buffer, contentType) {
  const { error } = await supabase.storage.from('artifacts').upload(path, buffer, { contentType, upsert: true })
  if (error) throw new Error(`Upload failed: ${error.message}`)
}

// Helper: stream a (possibly multi-GB) object from storage straight to a local
// file, without ever holding it in memory. `downloadVideo` above buffers the
// whole object into a Buffer, which OOM-kills the container on a 2.6 GB source.
// We mint a short-lived signed URL (works for private buckets too) and pipe the
// response body to disk — constant memory regardless of file size.
async function downloadToFile(supabase, videoPath, destPath) {
  const { data, error } = await supabase.storage.from('artifacts').createSignedUrl(videoPath, 1800)
  if (error || !data?.signedUrl) throw new Error(`Signed URL failed: ${error?.message ?? 'no url'}`)
  const res = await fetch(data.signedUrl)
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath))
}

/**
 * POST /convert
 * Convert video to MP4 (H.264 + faststart)
 */
app.post('/convert', async (req, res) => {
  const start = Date.now()
  try {
    const { videoPath, runId } = req.body
    if (!videoPath || !runId) return res.status(400).json({ error: 'videoPath and runId required' })

    const supabase = getSupabase(req.body)
    const buffer = await downloadVideo(supabase, videoPath)
    const sizeMB = (buffer.length / 1024 / 1024).toFixed(1)
    console.log(`[convert] ${sizeMB}MB ${videoPath}`)

    // Skip if already MP4
    if (videoPath.endsWith('.mp4')) {
      return res.json({ mp4Path: videoPath, skipped: true })
    }

    const ext = videoPath.substring(videoPath.lastIndexOf('.')) || '.webm'
    const tmpIn = join(tmpdir(), `in-${Date.now()}${ext}`)
    const tmpOut = join(tmpdir(), `out-${Date.now()}.mp4`)
    writeFileSync(tmpIn, buffer)

    // For .mov/.avi with H.264, try remux first (copy streams = instant)
    const isMov = ext === '.mov' || ext === '.avi' || ext === '.mkv'
    let converted = false

    if (isMov) {
      try {
        await new Promise((resolve, reject) => {
          ffmpeg(tmpIn)
            .outputOptions(['-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart'])
            .output(tmpOut)
            .on('end', resolve)
            .on('error', reject)
            .run()
        })
        converted = true
        console.log(`[convert] Remuxed ${ext} → MP4 (no re-encode)`)
      } catch {
        console.log(`[convert] Remux failed, falling back to re-encode`)
      }
    }

    if (!converted) {
      await new Promise((resolve, reject) => {
        ffmpeg(tmpIn)
          .inputOptions(['-threads', '0'])
          .outputOptions([
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-crf', '32',
            '-vf', 'scale=1280:-2',
            '-c:a', 'aac',
            '-b:a', '96k',
            '-ar', '44100',
            '-ac', '1',
            '-movflags', '+faststart',
            '-threads', '0',
          ])
          .output(tmpOut)
          .on('progress', (p) => {
            if (p.timemark) console.log(`[convert] ${p.timemark}`)
          })
          .on('end', resolve)
          .on('error', reject)
          .run()
      })
    }

    const mp4Buffer = readFileSync(tmpOut)
    const mp4Path = videoPath.replace(/\.[^.]+$/, '.mp4')
    await uploadFile(supabase, mp4Path, mp4Buffer, 'video/mp4')

    unlinkSync(tmpIn)
    unlinkSync(tmpOut)

    console.log(`[convert] Done in ${((Date.now() - start) / 1000).toFixed(1)}s → ${mp4Path}`)
    res.json({ mp4Path })
  } catch (err) {
    console.error('[convert] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /probe
 * Get video duration via ffprobe
 */
app.post('/probe', async (req, res) => {
  try {
    const { videoPath } = req.body
    if (!videoPath) return res.status(400).json({ error: 'videoPath required' })

    const supabase = getSupabase(req.body)
    const buffer = await downloadVideo(supabase, videoPath)

    const tmpIn = join(tmpdir(), `probe-${Date.now()}.mp4`)
    writeFileSync(tmpIn, buffer)

    const durationSeconds = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(tmpIn, (err, metadata) => {
        if (err) return reject(err)
        resolve(metadata.format.duration || 0)
      })
    })

    unlinkSync(tmpIn)

    console.log(`[probe] ${videoPath} → ${durationSeconds}s`)
    res.json({ durationSeconds })
  } catch (err) {
    console.error('[probe] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /extract-frames
 * Extract JPEG frames at specific timestamps
 */
app.post('/extract-frames', async (req, res) => {
  const start = Date.now()
  try {
    const { videoPath, runId, timestamps } = req.body
    if (!videoPath || !runId || !timestamps?.length) {
      return res.status(400).json({ error: 'videoPath, runId, and timestamps required' })
    }

    const supabase = getSupabase(req.body)
    const buffer = await downloadVideo(supabase, videoPath)
    console.log(`[frames] Extracting ${timestamps.length} frames from ${videoPath}`)

    const tmpIn = join(tmpdir(), `frames-${Date.now()}.mp4`)
    const tmpDir = join(tmpdir(), `frames-${Date.now()}`)
    writeFileSync(tmpIn, buffer)
    mkdirSync(tmpDir, { recursive: true })

    const framePaths = []

    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i]
      const outPath = join(tmpDir, `frame-${i}.jpg`)

      await new Promise((resolve, reject) => {
        ffmpeg(tmpIn)
          .seekInput(t)
          .frames(1)
          .outputOptions(['-vf', 'scale=1280:-2', '-q:v', '2'])
          .output(outPath)
          .on('end', resolve)
          .on('error', reject)
          .run()
      })

      try {
        const frameBuffer = readFileSync(outPath)
        const framePath = `runs/${runId}/frame-${i}.jpg`
        await uploadFile(supabase, framePath, frameBuffer, 'image/jpeg')
        framePaths.push(framePath)
      } catch {
        framePaths.push(null)
      }
    }

    // Cleanup
    try { unlinkSync(tmpIn) } catch {}
    try { for (const f of readdirSync(tmpDir)) unlinkSync(join(tmpDir, f)) } catch {}

    console.log(`[frames] Done in ${((Date.now() - start) / 1000).toFixed(1)}s → ${framePaths.length} frames`)
    res.json({ framePaths })
  } catch (err) {
    console.error('[frames] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /trim
 * Trim video to a time range
 */
app.post('/trim', async (req, res) => {
  try {
    const { videoPath, runId, startTime, endTime } = req.body
    if (!videoPath || !runId || startTime == null || endTime == null) {
      return res.status(400).json({ error: 'videoPath, runId, startTime, endTime required' })
    }

    const supabase = getSupabase(req.body)
    const buffer = await downloadVideo(supabase, videoPath)

    const tmpIn = join(tmpdir(), `trim-in-${Date.now()}.mp4`)
    const tmpOut = join(tmpdir(), `trim-out-${Date.now()}.mp4`)
    writeFileSync(tmpIn, buffer)

    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .setStartTime(startTime)
        .setDuration(endTime - startTime)
        .outputOptions(['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-movflags', '+faststart'])
        .output(tmpOut)
        .on('end', resolve)
        .on('error', reject)
        .run()
    })

    const trimmedBuffer = readFileSync(tmpOut)
    const trimmedPath = videoPath.replace(/\.[^.]+$/, '-trimmed.mp4')
    await uploadFile(supabase, trimmedPath, trimmedBuffer, 'video/mp4')

    unlinkSync(tmpIn)
    unlinkSync(tmpOut)

    res.json({ trimmedPath })
  } catch (err) {
    console.error('[trim] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /concat-audio
 * Concatenate audio segments with precise silence padding to sync with video timestamps
 */
app.post('/concat-audio', async (req, res) => {
  const start = Date.now()
  try {
    const { runId, segments: rawSegments } = req.body
    if (!runId || !rawSegments?.length) {
      return res.status(400).json({ error: 'runId and segments required' })
    }
    // Sort by targetStartTime to ensure correct silence calculation
    const segments = [...rawSegments].sort((a, b) => a.targetStartTime - b.targetStartTime)

    const supabase = getSupabase(req.body)
    const tmpDir = join(tmpdir(), `concat-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const parts = [] // ordered list of files to concat
    let currentTime = 0

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const targetStart = seg.targetStartTime

      // Download segment audio from Supabase
      const audioBuffer = await downloadVideo(supabase, seg.audioPath)
      const segPath = join(tmpDir, `seg-${i}.mp3`)
      writeFileSync(segPath, audioBuffer)

      // Probe actual duration
      const segDuration = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(segPath, (err, metadata) => {
          if (err) return reject(err)
          resolve(metadata.format.duration || 0)
        })
      })

      // Calculate silence needed — always relative to targetStart, not currentTime
      // This prevents drift accumulation when segments are longer than expected.
      // Inter-segment silence is capped at INTER_SILENCE_MAX so very sparse
      // step timestamps don't create long dead-air gaps; the narration
      // for step N+1 starts early instead and the audio stays close to
      // the video action. Leading silence (first segment) is kept intact —
      // it matches the video's natural lead-in.
      let silenceNeeded = Math.max(0, targetStart - currentTime)
      const INTER_SILENCE_MAX = 4
      if (i > 0 && silenceNeeded > INTER_SILENCE_MAX) silenceNeeded = INTER_SILENCE_MAX

      console.log(`[concat] Seg ${i}: target=${targetStart.toFixed(1)}s, current=${currentTime.toFixed(1)}s, silence=${silenceNeeded.toFixed(1)}s, audio=${segDuration.toFixed(1)}s${currentTime > targetStart ? ' ⚠️ OVERLAP' : ''}`)

      if (silenceNeeded > 0.05) {
        const silPath = join(tmpDir, `silence-${i}.mp3`)
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input('anullsrc=r=44100:cl=mono')
            .inputFormat('lavfi')
            .duration(silenceNeeded)
            .outputOptions(['-c:a', 'libmp3lame', '-b:a', '128k'])
            .output(silPath)
            .on('end', resolve)
            .on('error', reject)
            .run()
        })
        parts.push(silPath)
      }

      parts.push(segPath)
      // Track actual cumulative output-audio time. When silence got
      // clamped (INTER_SILENCE_MAX), the audio output is shorter than
      // the video targetStart would predict — so we can't just reset
      // to targetStart + segDuration or the drift keeps compounding.
      // Audio simply runs slightly ahead of video on sparse timestamps,
      // which is the intentional tradeoff for less dead air.
      currentTime += silenceNeeded + segDuration
    }

    // Write concat file list
    const listPath = join(tmpDir, 'list.txt')
    const listContent = parts.map(p => `file '${p}'`).join('\n')
    writeFileSync(listPath, listContent)

    // Concatenate all parts
    const outputPath = join(tmpDir, 'voiceover.mp3')
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c:a', 'libmp3lame', '-b:a', '128k'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run()
    })

    // Upload final file
    const finalBuffer = readFileSync(outputPath)
    const finalPath = `runs/${runId}/voiceover.mp3`
    await uploadFile(supabase, finalPath, finalBuffer, 'audio/mpeg')

    // Cleanup
    try { for (const f of readdirSync(tmpDir)) unlinkSync(join(tmpDir, f)) } catch {}

    console.log(`[concat] Done in ${((Date.now() - start) / 1000).toFixed(1)}s → ${finalPath} (${(finalBuffer.length / 1024).toFixed(0)}KB)`)
    res.json({ audioPath: finalPath })
  } catch (err) {
    console.error('[concat] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /mux
 * Combine a silent video with a narration audio track into a single MP4.
 * Used by the export feature so the ZIP backup contains a self-contained
 * playable file (VS Code, Obsidian, GitHub preview).
 *
 * Request:  { videoPath, audioPath, runId }
 * Response: { muxedPath: "runs/<runId>/video-with-voiceover.mp4" }
 *
 * Strategy: copy video stream (no re-encode), re-encode audio to AAC
 * (MP4 doesn't support MP3-in-video reliably across browsers). `-shortest`
 * trims to the shorter of the two streams so we don't dangle a black tail
 * when the voice-over runs longer than the video, or vice-versa.
 */
app.post('/mux', async (req, res) => {
  const start = Date.now()
  try {
    const { videoPath, audioPath, runId } = req.body
    if (!videoPath || !audioPath || !runId) {
      return res.status(400).json({ error: 'videoPath, audioPath, runId required' })
    }

    const supabase = getSupabase(req.body)
    const [videoBuffer, audioBuffer] = await Promise.all([
      downloadVideo(supabase, videoPath),
      downloadVideo(supabase, audioPath),
    ])

    const tmpVideo = join(tmpdir(), `mux-v-${Date.now()}.mp4`)
    const tmpAudio = join(tmpdir(), `mux-a-${Date.now()}.mp3`)
    const tmpOut = join(tmpdir(), `mux-out-${Date.now()}.mp4`)
    writeFileSync(tmpVideo, videoBuffer)
    writeFileSync(tmpAudio, audioBuffer)

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(tmpVideo)
        .input(tmpAudio)
        .outputOptions([
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-shortest',
          '-movflags', '+faststart',
        ])
        .output(tmpOut)
        .on('end', resolve)
        .on('error', reject)
        .run()
    })

    const muxedBuffer = readFileSync(tmpOut)
    const muxedPath = `runs/${runId}/video-with-voiceover.mp4`
    await uploadFile(supabase, muxedPath, muxedBuffer, 'video/mp4')

    try { unlinkSync(tmpVideo) } catch {}
    try { unlinkSync(tmpAudio) } catch {}
    try { unlinkSync(tmpOut) } catch {}

    console.log(`[mux] Done in ${((Date.now() - start) / 1000).toFixed(1)}s → ${muxedPath} (${(muxedBuffer.length / 1024 / 1024).toFixed(1)}MB)`)
    res.json({ muxedPath })
  } catch (err) {
    console.error('[mux] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /render-marketing-video
 * Render a Remotion composition to MP4. Doclee owns the trigger + the
 * compositions (shipped as a pre-bundled site at `remotionServeUrl`); we
 * just run Chromium + the Remotion renderer here because Vercel functions
 * can't host Chromium.
 *
 * Request:  { runId, manifestUrl, remotionServeUrl, compositionId, fps, widthPx, heightPx }
 * Response: { videoPath: "runs/<runId>/marketing.mp4" }
 *
 * The first call after a cold start downloads Chromium to /tmp via
 * `ensureBrowser()` (~150 MB, one-shot). Subsequent calls reuse it.
 */
app.post('/render-marketing-video', async (req, res) => {
  const start = Date.now()
  try {
    const {
      runId,
      manifestUrl,
      // Doclee can ship the manifest content inline (verified upstream).
      // Prefer it when present — avoids a network round-trip and the
      // chance of an intermediate proxy returning HTML.
      manifest: inlineManifest,
      remotionServeUrl,
      compositionId,
      fps,
      widthPx,
      heightPx,
    } = req.body
    if (!runId || !remotionServeUrl) {
      return res.status(400).json({ error: 'runId and remotionServeUrl required' })
    }
    if (!inlineManifest && !manifestUrl) {
      return res.status(400).json({ error: 'manifest or manifestUrl required' })
    }

    console.log(`[render-marketing] Start runId=${runId} bundle=${remotionServeUrl}`)

    const supabase = getSupabase(req.body)

    let manifest
    if (inlineManifest && typeof inlineManifest === 'object') {
      manifest = inlineManifest
      console.log('[render-marketing] Using inline manifest from request body')
    } else {
      console.log(`[render-marketing] Fetching manifest from ${manifestUrl}`)
      const manifestRes = await fetch(manifestUrl)
      if (!manifestRes.ok) throw new Error(`Manifest fetch failed: ${manifestRes.status} ${manifestRes.statusText}`)
      const text = await manifestRes.text()
      try {
        manifest = JSON.parse(text)
      } catch (err) {
        const preview = text.slice(0, 200).replace(/\s+/g, ' ')
        const ct = manifestRes.headers.get('content-type') ?? 'unknown'
        throw new Error(
          `Manifest URL returned non-JSON (content-type: ${ct}). First 200 chars: "${preview}". ` +
            `Original parse error: ${err.message}`,
        )
      }
    }

    console.log(
      `[render-marketing] Manifest loaded: ${manifest.script?.scenes?.length ?? '?'} scenes, ` +
        `${manifest.screenshots?.length ?? '?'} screenshots, lang=${manifest.script?.language ?? '?'}`,
    )

    const { ensureBrowser, selectComposition, renderMedia } = await import('@remotion/renderer')

    console.log('[render-marketing] Ensuring browser…')
    await ensureBrowser()

    console.log(`[render-marketing] selectComposition id=${compositionId || 'MarketingVideo'} serveUrl=${remotionServeUrl}`)
    const composition = await selectComposition({
      serveUrl: remotionServeUrl,
      id: compositionId || 'MarketingVideo',
      inputProps: { manifest },
    })

    console.log(`[render-marketing] Composition: ${composition.durationInFrames} frames @ ${composition.fps}fps`)

    const tmpOut = join(tmpdir(), `marketing-${runId}-${Date.now()}.mp4`)
    console.log(`[render-marketing] renderMedia → ${tmpOut}`)
    await renderMedia({
      composition,
      serveUrl: remotionServeUrl,
      codec: 'h264',
      outputLocation: tmpOut,
      inputProps: { manifest },
      // Concurrency null = let Remotion pick (cores - 1). On a 2-vCPU box
      // a 60s 1080p render lands in ~2-5 min; on 4-vCPU it's closer to 90s.
      concurrency: null,
      // Bump the per-frame render timeout. Default is 30s, which busts on
      // single frames that have heavy 3D transforms (perspective + rotateY
      // + multi-card composition stacks Chromium's software rasterizer).
      // 120s gives the bento + chat scenes (which use perspective tilts
      // for the magazine look) comfortable headroom — and we'd rather wait
      // than drop the 3D transforms that make the mocks feel designed.
      timeoutInMilliseconds: 120_000,
      // CRF 20 — visually near-lossless x264 encoding. Default is ~23
      // (Remotion tunes for size); on text-heavy mocks with thin 1-2px
      // lines and small typography that default reads as "slightly
      // blurry". 20 restores most of the sharpness without paying the
      // 18 file-size premium (~30% smaller MP4 than crf:18, only a
      // hair softer on a side-by-side). Trade vs default: file ~1.3-
      // 1.5× larger, acceptable for a 45s marketing asset.
      crf: 20,
      // x264Preset 'slower' = better compression efficiency at the cost
      // of encoding time. Default is 'medium'. At the same CRF, 'slower'
      // produces a ~10-15% smaller file AND visibly cleaner output on
      // text + thin lines (the encoder spends more time finding optimal
      // motion vectors / DCT decisions per frame). Trade: render time
      // ~2× — for marketing video (generated once, shared many times)
      // the asymmetry is worth it.
      x264Preset: 'slower',
    })

    console.log('[render-marketing] Render done, uploading…')
    const videoBuffer = readFileSync(tmpOut)
    const videoPath = `runs/${runId}/marketing.mp4`
    await uploadFile(supabase, videoPath, videoBuffer, 'video/mp4')

    try { unlinkSync(tmpOut) } catch {}

    console.log(`[render-marketing] Done in ${((Date.now() - start) / 1000).toFixed(1)}s → ${videoPath} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`)
    res.json({ videoPath })
  } catch (err) {
    // Full stack to logs so we can see WHERE the error came from. Send a
    // truncated stack back so Doclee surfaces it in the UI banner without
    // dumping the entire trace into the user's view.
    console.error('[render-marketing] Error:', err.message)
    console.error('[render-marketing] Stack:', err.stack)
    const shortStack = (err.stack || '').split('\n').slice(0, 6).join(' | ')
    res.status(500).json({ error: err.message, stack: shortStack })
  }
})

// ---------------------------------------------------------------------------
// Async long-video pipeline
//
// Doclee's Vercel functions are capped at 300s, which a 45-minute / multi-GB
// demo blows through (Gemini Files processing + a single long generateContent
// alone can take minutes). This service has no such cap, so Doclee hands the
// whole job here: we compress the recording below Gemini's 2 GB file limit,
// split it into chunks if it's long, run Gemini per chunk, merge + correct the
// timestamps, extract frames, and POST the result back to Doclee — which
// persists it and generates the doc. We respond 202 up front and do the work
// out-of-band; the only channel back is the callback.
//
// Memory note: like the other endpoints, this downloads the source into a
// Buffer. A 2.6 GB source needs a Railway instance sized accordingly (≥ 4 GB
// RAM recommended). The compressed copy used for chunking/frames is small.
// ---------------------------------------------------------------------------

// High output budget so a dense, exhaustive analysis of a ~10-min chunk isn't
// truncated (many steps × verbose descriptions). Gemini 2.5 Flash supports it.
const ANALYSIS_MAX_OUTPUT_TOKENS = 32768

/** ffprobe duration (seconds) for a local file. */
function probeDuration(path) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path, (err, metadata) => {
      if (err) return reject(err)
      resolve(metadata.format?.duration || 0)
    })
  })
}

/** Downscale + drop frame-rate + low-bitrate audio so the file lands well under
 *  Gemini's 2 GB limit. Gemini samples video at ~1 fps anyway, so fps=2 / 720p
 *  loses nothing useful for step detection while shrinking a multi-GB source to
 *  a few hundred MB. Audio is kept (low bitrate) for narration transcription. */
function compressForAnalysis(tmpIn, tmpOut) {
  return new Promise((resolve, reject) => {
    ffmpeg(tmpIn)
      .inputOptions(['-threads', '0'])
      .outputOptions([
        '-vf', 'scale=1280:-2,fps=2',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '30',
        '-c:a', 'aac',
        '-b:a', '64k',
        '-ac', '1',
        '-movflags', '+faststart',
        '-threads', '0',
      ])
      .output(tmpOut)
      .on('progress', (p) => { if (p.timemark) console.log(`[analyze] compress ${p.timemark}`) })
      .on('end', resolve)
      .on('error', reject)
      .run()
  })
}

/** Cut [start, start+len] out of a (already compressed) mp4. Stream-copy keeps
 *  it fast; keyframe-approx offsets are fine since we re-add `start` afterwards
 *  and clamp later. */
function cutChunk(tmpIn, start, len, tmpOut) {
  return new Promise((resolve, reject) => {
    ffmpeg(tmpIn)
      .inputOptions(['-ss', String(start)])
      .outputOptions(['-t', String(len), '-c', 'copy', '-movflags', '+faststart'])
      .output(tmpOut)
      .on('end', resolve)
      .on('error', reject)
      .run()
  })
}

/** Parse Gemini's analysis JSON — mirrors the tolerant parsing in Doclee's
 *  gemini.client.ts (strip fences, slice to outermost braces, fix MM:SS, repair
 *  truncation). Returns { steps, productName, summary } with safe defaults.
 *  Doclee re-validates the merged result with Zod, so this stays lenient. */
function parseGeminiAnalysis(text) {
  let jsonStr = (text || '').trim()
  const fence = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fence) jsonStr = fence[1]
  const first = jsonStr.indexOf('{')
  const last = jsonStr.lastIndexOf('}')
  if (first !== -1 && last > first) jsonStr = jsonStr.slice(first, last + 1)
  jsonStr = jsonStr.replace(/"timestamp"\s*:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g, (_m, p1, p2, p3) => {
    const mins = parseInt(p1, 10)
    const secs = parseInt(p2, 10)
    const hundredths = p3 ? parseInt(p3, 10) : 0
    return `"timestamp": ${mins * 60 + secs + hundredths / 100}`
  })

  let parsed
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    let repaired = jsonStr
      .replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, '')
      .replace(/,\s*\{[^}]*$/, '')
    const ob = (repaired.match(/\{/g) || []).length
    const cb = (repaired.match(/\}/g) || []).length
    const obk = (repaired.match(/\[/g) || []).length
    const cbk = (repaired.match(/\]/g) || []).length
    repaired += ']'.repeat(Math.max(0, obk - cbk))
    repaired += '}'.repeat(Math.max(0, ob - cb))
    parsed = JSON.parse(repaired)
  }

  const steps = Array.isArray(parsed.steps) ? parsed.steps : []
  return {
    steps: steps
      .filter((s) => s && typeof s.timestamp === 'number' && typeof s.userAction === 'string')
      .map((s) => ({
        timestamp: s.timestamp,
        screenDescription: typeof s.screenDescription === 'string' ? s.screenDescription : '',
        userAction: s.userAction,
        narration: typeof s.narration === 'string' ? s.narration : null,
      })),
    productName: typeof parsed.productName === 'string' ? parsed.productName : '',
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  }
}

/** Port of Doclee's correctTimestamps for a single segment of known length. */
function correctTimestamps(steps, durationSeconds) {
  if (!steps.length || !isFinite(durationSeconds) || durationSeconds <= 0) return steps
  const maxTs = Math.max(...steps.map((s) => s.timestamp))
  if (maxTs <= durationSeconds * 1.1) return steps
  return steps.map((s) => {
    if (s.timestamp < 60) return s
    const minutes = Math.floor(s.timestamp / 100)
    const seconds = s.timestamp % 100
    if (seconds >= 60) return s
    return { ...s, timestamp: Math.min(minutes * 60 + seconds, durationSeconds - 1) }
  })
}

/** Upload one local file to the Gemini Files API and run the analysis prompt. */
async function analyzeChunkWithGemini(genAI, fileManager, chunkPath, model, prompt) {
  const uploadResult = await fileManager.uploadFile(chunkPath, {
    mimeType: 'video/mp4',
    displayName: basename(chunkPath),
  })
  let file = uploadResult.file
  while (file.state === 'PROCESSING') {
    await new Promise((r) => setTimeout(r, 3000))
    file = await fileManager.getFile(file.name)
  }
  if (file.state === 'FAILED') throw new Error('Gemini failed to process the video chunk')

  try {
    const genModel = genAI.getGenerativeModel({
      model,
      generationConfig: { maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS },
    })
    const result = await genModel.generateContent([
      { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
      { text: prompt },
    ])
    return parseGeminiAnalysis(result.response.text())
  } finally {
    await fileManager.deleteFile(file.name).catch(() => {})
  }
}

/** POST the final result (or failure) back to Doclee. */
async function postCallback(callbackUrl, callbackSecret, body) {
  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-callback-secret': callbackSecret },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const preview = (await res.text().catch(() => '')).slice(0, 300)
    console.error(`[analyze] Callback failed ${res.status}: ${preview}`)
  } else {
    console.log(`[analyze] Callback delivered (${body.ok ? 'ok' : 'error'}) for run ${body.runId}`)
  }
}

async function runAnalysisPipeline(params) {
  const {
    runId, videoPath, jobId, triggeredByUserId,
    geminiApiKey, geminiModel, analysisPrompt, chunkSeconds,
    callbackUrl, callbackSecret, body,
  } = params

  const tempFiles = []
  const start = Date.now()
  try {
    // Log BEFORE the download so the stdout shows the background task actually
    // started — previously the first log came only after the (multi-GB)
    // download, so an OOM mid-download left zero trace beyond the 202.
    console.log(`[analyze] start run=${runId} — downloading ${videoPath}`)
    const supabase = getSupabase(body)

    const ext = videoPath.substring(videoPath.lastIndexOf('.')) || '.mp4'
    const tmpIn = join(tmpdir(), `analyze-in-${Date.now()}${ext}`)
    const tmpCompressed = join(tmpdir(), `analyze-c-${Date.now()}.mp4`)
    tempFiles.push(tmpIn, tmpCompressed)

    // Stream the source straight to disk — never hold it in memory.
    await downloadToFile(supabase, videoPath, tmpIn)
    console.log(`[analyze] run=${runId} downloaded → ${tmpIn}`)

    // 1. Compress/downscale below Gemini's 2 GB limit.
    await compressForAnalysis(tmpIn, tmpCompressed)
    try { unlinkSync(tmpIn) } catch {}
    const compressedSize = readFileSync(tmpCompressed).length
    const duration = await probeDuration(tmpCompressed)
    console.log(`[analyze] compressed → ${(compressedSize / 1024 / 1024).toFixed(1)}MB, ${duration.toFixed(0)}s`)

    // 2. Upload the compressed copy as the playable video (the original may be
    //    several GB — too heavy for browser playback on the doc page).
    const compressedPath = `runs/${runId}/analysis-source.mp4`
    await uploadFile(supabase, compressedPath, readFileSync(tmpCompressed), 'video/mp4')

    // 3. Chunk into ~chunkSeconds segments. We split EVERY recording longer
    //    than one chunk (not just very long ones) so each segment gets its own
    //    dedicated, exhaustive Gemini pass with the full output-token budget —
    //    a single 38-min call would under-cover and risk truncation. A short
    //    recording (≤ one chunk) analyses the compressed file directly.
    const chunkLen = chunkSeconds && chunkSeconds > 0 ? chunkSeconds : 600
    const chunks = []
    if (duration <= chunkLen) {
      chunks.push({ start: 0, len: duration, path: tmpCompressed })
    } else {
      for (let s = 0; s < duration; s += chunkLen) {
        const len = Math.min(chunkLen, duration - s)
        const chunkPath = join(tmpdir(), `analyze-chunk-${Date.now()}-${s}.mp4`)
        tempFiles.push(chunkPath)
        await cutChunk(tmpCompressed, s, len, chunkPath)
        chunks.push({ start: s, len, path: chunkPath })
      }
    }
    console.log(`[analyze] ${chunks.length} chunk(s)`)

    // 4. Gemini per chunk → merge with offsets.
    const genAI = new GoogleGenerativeAI(geminiApiKey)
    const fileManager = new GoogleAIFileManager(geminiApiKey)
    const model = geminiModel || 'gemini-2.5-flash'

    let allSteps = []
    let productName = ''
    const summaries = []
    for (const chunk of chunks) {
      const analysis = await analyzeChunkWithGemini(genAI, fileManager, chunk.path, model, analysisPrompt)
      if (!productName && analysis.productName) productName = analysis.productName
      if (analysis.summary) summaries.push(analysis.summary)
      const corrected = correctTimestamps(analysis.steps, chunk.len)
      for (const s of corrected) {
        allSteps.push({ ...s, timestamp: s.timestamp + chunk.start })
      }
      console.log(`[analyze] chunk @${chunk.start}s → ${corrected.length} steps`)
    }

    if (allSteps.length === 0) throw new Error('Gemini detected no documentable steps in the recording')

    // 5. Global sort + clamp into the video, then the safety-gap clamp so a
    //    step's frame never bleeds into the next step's state.
    allSteps.sort((a, b) => a.timestamp - b.timestamp)
    allSteps = allSteps.map((s) => ({ ...s, timestamp: Math.max(0, Math.min(s.timestamp, duration - 0.1)) }))
    const SAFETY_GAP = 0.6
    for (let i = 0; i < allSteps.length - 1; i++) {
      const ceil = Math.max(0, allSteps[i + 1].timestamp - SAFETY_GAP)
      if (allSteps[i].timestamp > ceil) allSteps[i].timestamp = ceil
    }

    // 6. Extract a frame per step from the compressed video.
    const framesDir = join(tmpdir(), `analyze-frames-${Date.now()}`)
    mkdirSync(framesDir, { recursive: true })
    const finalSteps = []
    for (let i = 0; i < allSteps.length; i++) {
      const s = allSteps[i]
      const outPath = join(framesDir, `frame-${i}.jpg`)
      let screenshotPath = null
      try {
        await new Promise((resolve, reject) => {
          ffmpeg(tmpCompressed)
            .seekInput(s.timestamp)
            .frames(1)
            .outputOptions(['-vf', 'scale=1280:-2', '-q:v', '2'])
            .output(outPath)
            .on('end', resolve)
            .on('error', reject)
            .run()
        })
        const framePath = `runs/${runId}/frame-${i}.jpg`
        await uploadFile(supabase, framePath, readFileSync(outPath), 'image/jpeg')
        screenshotPath = framePath
      } catch (err) {
        console.warn(`[analyze] frame ${i} failed: ${err.message}`)
      }
      finalSteps.push({
        timestamp: s.timestamp,
        // Keep the callback body well under Doclee's JSON limit even for a
        // long demo with many steps — trim verbose fields rather than risk a
        // 413. The full recording still drives doc generation downstream.
        screenDescription: (s.screenDescription || '').slice(0, 600),
        userAction: (s.userAction || '').slice(0, 400),
        narration: s.narration ? s.narration.slice(0, 500) : null,
        screenshotPath,
      })
    }
    try { for (const f of readdirSync(framesDir)) unlinkSync(join(framesDir, f)) } catch {}

    console.log(`[analyze] Done in ${((Date.now() - start) / 1000).toFixed(1)}s → ${finalSteps.length} steps`)

    // 7. Hand the result back to Doclee for persistence + doc generation.
    await postCallback(callbackUrl, callbackSecret, {
      runId,
      jobId,
      triggeredByUserId: triggeredByUserId ?? null,
      ok: true,
      productName,
      summary: summaries.join(' ').slice(0, 2000),
      videoPath: compressedPath,
      steps: finalSteps,
    })
  } catch (err) {
    console.error(`[analyze] Pipeline failed for run ${runId}:`, err.message)
    await postCallback(callbackUrl, callbackSecret, {
      runId,
      jobId,
      triggeredByUserId: triggeredByUserId ?? null,
      ok: false,
      error: err.message,
    }).catch(() => {})
  } finally {
    for (const f of tempFiles) { try { unlinkSync(f) } catch {} }
  }
}

/**
 * POST /process-and-analyze
 * Async entry point for the long-video pipeline. Validates, responds 202, then
 * processes out-of-band and reports back via the callback.
 */
app.post('/process-and-analyze', (req, res) => {
  const {
    runId, videoPath, jobId, triggeredByUserId,
    geminiApiKey, geminiModel, analysisPrompt, chunkSeconds,
    callbackUrl, callbackSecret,
  } = req.body || {}

  if (!runId || !videoPath || !jobId || !geminiApiKey || !analysisPrompt || !callbackUrl || !callbackSecret) {
    return res.status(400).json({
      error: 'runId, videoPath, jobId, geminiApiKey, analysisPrompt, callbackUrl and callbackSecret are required',
    })
  }
  if (!req.body.supabaseUrl || !req.body.serviceKey) {
    return res.status(400).json({ error: 'supabaseUrl and serviceKey required' })
  }

  // Accept first, work after — the caller (Vercel) must not block on a 45-min job.
  res.status(202).json({ accepted: true })

  runAnalysisPipeline({
    runId, videoPath, jobId, triggeredByUserId,
    geminiApiKey, geminiModel, analysisPrompt, chunkSeconds,
    callbackUrl, callbackSecret,
    body: req.body,
  }).catch((err) => console.error('[analyze] Unhandled pipeline error:', err))
})

app.listen(PORT, () => console.log(`Video service running on port ${PORT}`))
