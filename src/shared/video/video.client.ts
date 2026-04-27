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

/**
 * Mux a silent video with a narration audio track into a single self-contained
 * MP4. Used by the export feature so the ZIP backup contains a playable video
 * for external editors (VS Code, Obsidian, GitHub preview) instead of forcing
 * the user to sync two files manually.
 *
 * Expected server contract (to implement on the video-service side):
 *   POST /mux
 *   body: { videoPath, audioPath, runId }
 *   -> { muxedPath: "runs/<runId>/video-with-voiceover.mp4" }
 *
 * The service should: download both inputs from the artifacts bucket, run
 * `ffmpeg -i video -i audio -c:v copy -c:a aac -shortest out.mp4`, and upload
 * the result back to the same bucket. Caching by (videoPath, audioPath) is
 * welcome but not required — the export path is idempotent.
 */
export async function muxVideoWithAudio(
  videoPath: string,
  audioPath: string,
  runId: string,
): Promise<string> {
  const result = await callService<{ muxedPath: string }>('/mux', { videoPath, audioPath, runId })
  console.log(`[video-service] Muxed video+audio → ${result.muxedPath}`)
  return result.muxedPath
}

/**
 * Render a Remotion marketing-video composition to MP4. Vercel serverless
 * functions can't host Chromium (Remotion needs ~170 MB), so this work is
 * delegated to the standalone video-service that already runs ffmpeg-heavy
 * jobs.
 *
 * Expected server contract (to implement on the video-service side):
 *   POST /render-marketing-video
 *   body: {
 *     runId: string,
 *     manifestUrl: string,        // public JSON manifest produced by Doclee
 *     compositionId: "MarketingVideo",
 *     remotionServeUrl: string,   // pre-bundled Remotion site, see
 *                                 //   `npm run remotion:bundle` + the
 *                                 //   distribution notes in remotion/README.md
 *     fps: 30,
 *     widthPx: 1920,
 *     heightPx: 1080,
 *   }
 *   -> { videoPath: "runs/<runId>/marketing.mp4" }
 *
 * Server-side implementation hints:
 *   - Fetch the manifest, pass it as `inputProps` to selectComposition + renderMedia.
 *   - Use @remotion/renderer with codec h264 and a sane concurrency.
 *   - Upload the MP4 back to the artifacts bucket and return the path —
 *     same pattern as convertToMp4 / muxVideoWithAudio.
 *   - Cap render time (60s × 30fps = 1800 frames is well within 5 min on a
 *     2-vCPU box; alert if it goes over so we know to scale up).
 */
export async function renderMarketingVideo(input: {
  runId: string
  manifestUrl: string
  remotionServeUrl: string
  compositionId?: string
  fps?: number
  widthPx?: number
  heightPx?: number
}): Promise<string> {
  const result = await callService<{ videoPath: string }>('/render-marketing-video', {
    runId: input.runId,
    manifestUrl: input.manifestUrl,
    compositionId: input.compositionId ?? 'MarketingVideo',
    remotionServeUrl: input.remotionServeUrl,
    fps: input.fps ?? 30,
    widthPx: input.widthPx ?? 1920,
    heightPx: input.heightPx ?? 1080,
  })
  console.log(`[video-service] Rendered marketing video → ${result.videoPath}`)
  return result.videoPath
}
