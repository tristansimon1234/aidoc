import ffmpeg from 'fluent-ffmpeg'
import { writeFileSync, unlinkSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Try to locate ffmpeg binary
let ffmpegBinaryPath: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const installer = require('@ffmpeg-installer/ffmpeg') as { path: string }
  if (installer.path && existsSync(installer.path)) {
    ffmpegBinaryPath = installer.path
    ffmpeg.setFfmpegPath(installer.path)
    console.log(`[ffmpeg] Found binary at: ${installer.path}`)
  }
} catch {
  // Try system ffmpeg
  try {
    const systemPath = execSync('which ffmpeg', { timeout: 5000 }).toString().trim()
    if (systemPath) {
      ffmpegBinaryPath = systemPath
      ffmpeg.setFfmpegPath(systemPath)
      console.log(`[ffmpeg] Using system binary: ${systemPath}`)
    }
  } catch {
    console.warn('[ffmpeg] No ffmpeg binary found — video processing will fail')
  }
}

/** Check if ffmpeg is available */
export function isAvailable(): boolean {
  return ffmpegBinaryPath !== null
}

/**
 * Convert a video buffer (any format) to MP4 (H.264).
 * MP4 has precise keyframe seeking — critical for accurate frame extraction.
 */
export async function convertToMp4(inputBuffer: Buffer, inputFormat: string): Promise<Buffer> {
  // If already MP4, return as-is
  if (inputFormat === 'video/mp4') return inputBuffer

  const tmpIn = join(tmpdir(), `aidoc-in-${Date.now()}.${inputFormat.includes('webm') ? 'webm' : 'mov'}`)
  const tmpOut = join(tmpdir(), `aidoc-out-${Date.now()}.mp4`)

  try {
    writeFileSync(tmpIn, inputBuffer)

    await new Promise<void>((resolve, reject) => {
      ffmpeg(tmpIn)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-c:a', 'aac',
          '-movflags', '+faststart', // Enables progressive loading + better seeking
        ])
        .output(tmpOut)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run()
    })

    return readFileSync(tmpOut)
  } finally {
    try { unlinkSync(tmpIn) } catch { /* ignore */ }
    try { unlinkSync(tmpOut) } catch { /* ignore */ }
  }
}

/**
 * Extract frames from a video at specific timestamps using ffmpeg.
 * Returns an array of JPEG buffers, one per timestamp.
 * Much more precise than browser-side canvas seeking.
 */
export async function extractFrames(
  videoBuffer: Buffer,
  timestamps: number[],
  width = 1280,
): Promise<Buffer[]> {
  const tmpIn = join(tmpdir(), `aidoc-frames-${Date.now()}.mp4`)
  const tmpDir = join(tmpdir(), `aidoc-frames-${Date.now()}`)

  try {
    writeFileSync(tmpIn, videoBuffer)
    mkdirSync(tmpDir, { recursive: true })

    // Extract each frame individually for precision
    const frames: Buffer[] = []

    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i]!
      const outPath = join(tmpDir, `frame-${i}.jpg`)

      await new Promise<void>((resolve, reject) => {
        ffmpeg(tmpIn)
          .seekInput(t)
          .frames(1)
          .outputOptions([
            '-vf', `scale=${width}:-2`,
            '-q:v', '2', // High quality JPEG
          ])
          .output(outPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run()
      })

      try {
        frames.push(readFileSync(outPath))
      } catch {
        // Frame extraction failed for this timestamp — push empty
        frames.push(Buffer.alloc(0))
      }
    }

    return frames
  } finally {
    try { unlinkSync(tmpIn) } catch { /* ignore */ }
    try {
      for (const f of readdirSync(tmpDir)) unlinkSync(join(tmpDir, f))
      unlinkSync(tmpDir)
    } catch { /* ignore */ }
  }
}

/**
 * Trim a video to a specific time range.
 * Returns the trimmed video as an MP4 buffer.
 */
export async function trimVideo(
  videoBuffer: Buffer,
  startTime: number,
  endTime: number,
): Promise<Buffer> {
  const tmpIn = join(tmpdir(), `aidoc-trim-in-${Date.now()}.mp4`)
  const tmpOut = join(tmpdir(), `aidoc-trim-out-${Date.now()}.mp4`)

  try {
    writeFileSync(tmpIn, videoBuffer)

    await new Promise<void>((resolve, reject) => {
      ffmpeg(tmpIn)
        .setStartTime(startTime)
        .setDuration(endTime - startTime)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-c:a', 'aac',
          '-movflags', '+faststart',
        ])
        .output(tmpOut)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run()
    })

    return readFileSync(tmpOut)
  } finally {
    try { unlinkSync(tmpIn) } catch { /* ignore */ }
    try { unlinkSync(tmpOut) } catch { /* ignore */ }
  }
}

/**
 * Get video duration in seconds.
 */
export async function getVideoDuration(videoBuffer: Buffer): Promise<number> {
  const tmpIn = join(tmpdir(), `aidoc-dur-${Date.now()}.mp4`)

  try {
    writeFileSync(tmpIn, videoBuffer)

    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(tmpIn, (err, metadata) => {
        if (err) { reject(err); return }
        resolve(metadata.format.duration ?? 0)
      })
    })
  } finally {
    try { unlinkSync(tmpIn) } catch { /* ignore */ }
  }
}
