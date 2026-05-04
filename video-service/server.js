import express from 'express'
import ffmpeg from 'fluent-ffmpeg'
import { createClient } from '@supabase/supabase-js'
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const app = express()
app.use(express.json({ limit: '300mb' }))

const PORT = process.env.PORT || 3001

// Health check
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'aidoc-video' })
})

// Helper: create supabase client from request
function getSupabase(body) {
  if (!body.supabaseUrl || !body.serviceKey) throw new Error('supabaseUrl and serviceKey required')
  return createClient(body.supabaseUrl, body.serviceKey)
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

app.listen(PORT, () => console.log(`Video service running on port ${PORT}`))
