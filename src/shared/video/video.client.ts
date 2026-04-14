import { env } from '../config/env.js'

function getBaseUrl(): string {
  if (!env.VIDEO_SERVICE_URL) throw new Error('VIDEO_SERVICE_URL is not configured')
  return env.VIDEO_SERVICE_URL
}

export function isVideoServiceConfigured(): boolean {
  return Boolean(env.VIDEO_SERVICE_URL)
}

/** Wake up Railway service (cold start can take 10-30s) */
let lastPing = 0
async function ensureAwake(): Promise<void> {
  const now = Date.now()
  if (now - lastPing < 5 * 60_000) return // Skip if pinged < 5min ago
  lastPing = now
  const base = getBaseUrl()
  console.log(`[video-service] Waking up service...`)
  try {
    await fetch(`${base}/health`, { signal: AbortSignal.timeout(30_000) })
    console.log(`[video-service] Service is awake`)
  } catch {
    console.log(`[video-service] No /health endpoint — trying anyway`)
  }
}

async function callService<T>(endpoint: string, body: Record<string, unknown>, timeoutMs = 180_000): Promise<T> {
  // Wake up service first (Railway cold starts)
  await ensureAwake()

  const url = `${getBaseUrl()}${endpoint}`
  console.log(`[video-service] POST ${endpoint} (timeout: ${timeoutMs / 1000}s)`)

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

  if (!res.ok) {
    const errBody = await res.text().catch(() => res.statusText)
    console.error(`[video-service] ${endpoint} failed (${res.status}): ${errBody}`)
    throw new Error(`Video service error (${res.status}): ${errBody}`)
  }

  return res.json() as Promise<T>
}

/** Convert video to MP4. Returns the new path in Supabase storage. Timeout: 60s. */
export async function convertToMp4(videoPath: string, runId: string): Promise<string> {
  const result = await callService<{ mp4Path: string; skipped?: boolean }>('/convert', { videoPath, runId }, 60_000)
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
