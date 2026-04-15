import { env } from '../config/env.js'

function getBaseUrl(): string {
  if (!env.VIDEO_SERVICE_URL) throw new Error('VIDEO_SERVICE_URL is not configured')
  return env.VIDEO_SERVICE_URL
}

export function isVideoServiceConfigured(): boolean {
  return Boolean(env.VIDEO_SERVICE_URL)
}

/** Wake up Railway service and verify it's healthy */
let lastPing = 0
async function ensureAwake(): Promise<void> {
  const now = Date.now()
  if (now - lastPing < 5 * 60_000) return
  lastPing = now
  const base = getBaseUrl()
  console.log(`[video-service] Pinging ${base}/health ...`)
  try {
    const start = Date.now()
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(30_000) })
    const body = await res.text().catch(() => '')
    console.log(`[video-service] Health: ${res.status} (${Date.now() - start}ms) ${body.slice(0, 100)}`)
  } catch (err) {
    console.warn(`[video-service] Health check failed: ${(err as Error).message}`)
  }
}

async function callService<T>(endpoint: string, body: Record<string, unknown>, timeoutMs = 180_000): Promise<T> {
  await ensureAwake()

  const url = `${getBaseUrl()}${endpoint}`
  const start = Date.now()
  console.log(`[video-service] POST ${endpoint} (timeout: ${timeoutMs / 1000}s) body keys: ${Object.keys(body).join(', ')}`)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      supabaseUrl: env.SUPABASE_URL,
      serviceKey: env.SUPABASE_SERVICE_KEY,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  const elapsed = Date.now() - start
  console.log(`[video-service] ${endpoint} responded: ${res.status} (${elapsed}ms)`)

  if (!res.ok) {
    const errBody = await res.text().catch(() => res.statusText)
    console.error(`[video-service] ${endpoint} ERROR: ${errBody}`)
    throw new Error(`Video service error (${res.status}): ${errBody}`)
  }

  return res.json() as Promise<T>
}

/** Convert video to MP4. Returns the new path in Supabase storage. Timeout: 30s. */
export async function convertToMp4(videoPath: string, runId: string): Promise<string> {
  const result = await callService<{ mp4Path: string; skipped?: boolean }>('/convert', { videoPath, runId }, 30_000)
  if (result.skipped) console.log('[video-service] Already MP4, skipped conversion')
  else console.log(`[video-service] Converted → ${result.mp4Path}`)
  return result.mp4Path
}

/** Extract frames at timestamps. Returns array of frame paths in Supabase storage. */
export async function extractFrames(videoPath: string, runId: string, timestamps: number[]): Promise<(string | null)[]> {
  const result = await callService<{ framePaths: (string | null)[] }>('/extract-frames', { videoPath, runId, timestamps })
  console.log(`[video-service] Extracted ${result.framePaths.filter(Boolean).length}/${timestamps.length} frames`)
  return result.framePaths
}

/** Get video duration via ffprobe. */
export async function probeVideo(videoPath: string): Promise<{ durationSeconds: number }> {
  return callService<{ durationSeconds: number }>('/probe', { videoPath })
}

/** Concatenate audio segments with silence padding for video sync. Returns final audio path. */
export async function concatAudio(
  runId: string,
  segments: { audioPath: string; targetStartTime: number }[],
): Promise<string> {
  const result = await callService<{ audioPath: string }>('/concat-audio', { runId, segments })
  console.log(`[video-service] Concatenated ${segments.length} audio segments → ${result.audioPath}`)
  return result.audioPath
}

/** Trim video to time range. Returns the trimmed video path. */
export async function trimVideo(videoPath: string, runId: string, startTime: number, endTime: number): Promise<string> {
  const result = await callService<{ trimmedPath: string }>('/trim', { videoPath, runId, startTime, endTime })
  return result.trimmedPath
}
