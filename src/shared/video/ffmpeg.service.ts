import ffmpeg from 'fluent-ffmpeg'
import { writeFileSync, unlinkSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Locate ffmpeg binary — multiple strategies for different environments
let ffmpegBinaryPath: string | null = null

function trySetPath(path: string, source: string): boolean {
  if (path && existsSync(path)) {
    ffmpegBinaryPath = path
    ffmpeg.setFfmpegPath(path)
    console.log(`[ffmpeg] ${source}: ${path}`)
    return true
  }
  return false
}

// Strategy 1: @ffmpeg-installer/ffmpeg package
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const installer = require('@ffmpeg-installer/ffmpeg') as { path: string }
  trySetPath(installer.path, 'Found via @ffmpeg-installer')
} catch (e) {
  console.log(`[ffmpeg] @ffmpeg-installer not available: ${(e as Error).message}`)
}

// Strategy 2: Look for binary in node_modules manually
if (!ffmpegBinaryPath) {
  const searchRoots = [
    process.cwd(),
    '/var/task',           // Vercel Lambda
    '/vercel/path0',       // Vercel build
    __dirname,             // Relative to this file
    join(__dirname, '..', '..', '..'), // Project root from src/shared/video/
  ]
  const subPaths = [
    'node_modules/@ffmpeg-installer/linux-x64/ffmpeg',
    'node_modules/@ffmpeg-installer/ffmpeg/ffmpeg',
  ]
  for (const root of searchRoots) {
    for (const sub of subPaths) {
      if (trySetPath(join(root, sub), `Found at ${root}`)) break
    }
    if (ffmpegBinaryPath) break
  }
}

// Strategy 3: System ffmpeg
if (!ffmpegBinaryPath) {
  try {
    const systemPath = execSync('which ffmpeg', { timeout: 5000 }).toString().trim()
    trySetPath(systemPath, 'Found system ffmpeg')
  } catch {
    // not available
  }
}

if (!ffmpegBinaryPath) {
  console.warn('[ffmpeg] No ffmpeg binary found in any location')
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

  const start = Date.now()
  const sizeMB = (inputBuffer.length / 1024 / 1024).toFixed(1)
  console.log(`[ffmpeg] Converting ${sizeMB}MB ${inputFormat} → MP4...`)

  const tmpIn = join(tmpdir(), `aidoc-in-${Date.now()}.${inputFormat.includes('webm') ? 'webm' : 'mov'}`)
  const tmpOut = join(tmpdir(), `aidoc-out-${Date.now()}.mp4`)

  try {
    writeFileSync(tmpIn, inputBuffer)

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error('[ffmpeg] Conversion timed out after 120s')
        reject(new Error('ffmpeg conversion timed out'))
      }, 120_000)

      ffmpeg(tmpIn)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'ultrafast',  // fastest encoding — critical for serverless
          '-crf', '28',            // slightly lower quality but much faster
          '-c:a', 'aac',
          '-b:a', '128k',
          '-movflags', '+faststart',
          '-threads', '2',
        ])
        .output(tmpOut)
        .on('progress', (p: { percent?: number }) => {
          if (p.percent) console.log(`[ffmpeg] Converting: ${p.percent.toFixed(0)}%`)
        })
        .on('end', () => { clearTimeout(timeout); resolve() })
        .on('error', (err: Error) => { clearTimeout(timeout); reject(err) })
        .run()
    })

    const result = readFileSync(tmpOut)
    console.log(`[ffmpeg] Conversion done in ${((Date.now() - start) / 1000).toFixed(1)}s → ${(result.length / 1024 / 1024).toFixed(1)}MB`)
    return result
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
