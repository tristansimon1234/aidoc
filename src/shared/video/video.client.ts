import { env } from '../config/env.js'

function getBaseUrl(): string {
  if (!env.VIDEO_SERVICE_URL) throw new Error('VIDEO_SERVICE_URL is not configured')
  return env.VIDEO_SERVICE_URL
}

export function isVideoServiceConfigured(): boolean {
  return Boolean(env.VIDEO_SERVICE_URL)
}

async function callService<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const url = `${getBaseUrl()}${endpoint}`
  console.log(`[video-service] POST ${endpoint}`)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      supabaseUrl: env.SUPABASE_URL,
      serviceKey: env.SUPABASE_SERVICE_KEY,
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
    throw new Error(`Video service error: ${err.error ?? res.statusText}`)
  }

  return res.json() as Promise<T>
}

/** Convert video to MP4. Returns the new path in Supabase storage. */
export async function convertToMp4(videoPath: string, runId: string): Promise<string> {
  const result = await callService<{ mp4Path: string; skipped?: boolean }>('/convert', { videoPath, runId })
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

/** Trim video to time range. Returns the trimmed video path. */
export async function trimVideo(videoPath: string, runId: string, startTime: number, endTime: number): Promise<string> {
  const result = await callService<{ trimmedPath: string }>('/trim', { videoPath, runId, startTime, endTime })
  return result.trimmedPath
}
