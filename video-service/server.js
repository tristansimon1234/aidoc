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
    const { runId, segments } = req.body
    if (!runId || !segments?.length) {
      return res.status(400).json({ error: 'runId and segments required' })
    }

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

      // Calculate silence needed before this segment
      const silenceNeeded = Math.max(0, targetStart - currentTime)

      console.log(`[concat] Seg ${i}: target=${targetStart.toFixed(1)}s, current=${currentTime.toFixed(1)}s, silence=${silenceNeeded.toFixed(1)}s, audio=${segDuration.toFixed(1)}s`)

      if (silenceNeeded > 0.05) {
        // Generate silence
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
      currentTime = targetStart + segDuration
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

app.listen(PORT, () => console.log(`Video service running on port ${PORT}`))
