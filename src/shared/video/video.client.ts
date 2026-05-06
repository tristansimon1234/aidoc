import { env } from '../config/env.js'
import { createSignedUploadUrl, getPublicUrl } from '../db/storage.repository.js'

function getBaseUrl(): string {
  if (!env.VIDEO_SERVICE_URL) throw new Error('VIDEO_SERVICE_URL is not configured')
  return env.VIDEO_SERVICE_URL
}

export function isVideoServiceConfigured(): boolean {
  return Boolean(env.VIDEO_SERVICE_URL)
}

interface SignedOutput {
  /** Storage path the video-service will upload to (echoed back in
   *  the response so the caller doesn't have to remember it). */
  path: string
  /** Signed Supabase upload URL the video-service PUTs the bytes to. */
  uploadUrl: string
}

interface PublicInput {
  /** Storage path. Echoed for logging / future migration to private
   *  buckets where downloadUrl would be a signed URL too. */
  path: string
  /** Public Supabase URL the video-service fetches from. The artifacts
   *  bucket is public, so no auth needed. */
  downloadUrl: string
}

/** Pre-sign a Supabase upload URL for an output the video-service is
 *  about to produce. The signed URL is the only way the video-service
 *  can write to the bucket — it has no service-role key anymore. */
async function signOutput(path: string): Promise<SignedOutput> {
  const uploadUrl = await createSignedUploadUrl('artifacts', path)
  return { path, uploadUrl }
}

function publicInput(path: string): PublicInput {
  const url = getPublicUrl('artifacts', path)
  if (!url) throw new Error(`Could not compute public URL for ${path}`)
  return { path, downloadUrl: url }
}

async function callService<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const url = `${getBaseUrl()}${endpoint}`
  // Log payload keys so we can see what we sent if the service returns
  // a cryptic error. Token-bearing fields (uploadUrl, downloadUrl) are
  // present but harmless to log — they're scoped to a single object
  // and expire in ~2h.
  console.log(`[video-service] POST ${endpoint} payload:`, JSON.stringify(body, (_k, v) => {
    if (typeof v === 'string' && v.length > 200) return `${v.slice(0, 60)}…(${v.length}chars)`
    return v
  }))

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  // Read the body once as text — when the service returns a cryptic error
  // like "Unexpected token '<'" we want the full payload visible in logs,
  // not just the parsed `error` field. Same pattern works for both ok and
  // non-ok responses; we parse JSON ourselves below.
  const rawText = await res.text()

  if (!res.ok) {
    let parsed: { error?: string; details?: unknown; stack?: string } = {}
    try {
      parsed = JSON.parse(rawText)
    } catch {
      // Body wasn't JSON — fall through with rawText preview as the error.
    }
    const preview = rawText.replace(/\s+/g, ' ').slice(0, 400)
    console.error(
      `[video-service] ${endpoint} failed (${res.status} ${res.statusText}). Body: ${preview}`,
    )
    if (parsed.stack) console.error(`[video-service] Remote stack: ${parsed.stack}`)
    const stackSuffix = parsed.stack ? ` [remote stack: ${parsed.stack}]` : ''
    const detailsSuffix = parsed.details ? ` (details: ${JSON.stringify(parsed.details).slice(0, 200)})` : ''
    const detail = parsed.error
      ? `${parsed.error}${detailsSuffix}${stackSuffix}`
      : `HTTP ${res.status} ${res.statusText} — body: ${preview}`
    throw new Error(`Video service error: ${detail}`)
  }

  try {
    return JSON.parse(rawText) as T
  } catch (err) {
    const preview = rawText.replace(/\s+/g, ' ').slice(0, 400)
    console.error(
      `[video-service] ${endpoint} returned non-JSON body despite 200 OK. First 400 chars: ${preview}`,
    )
    throw new Error(
      `Video service returned non-JSON success response: ${(err as Error).message}. Body preview: "${preview}"`,
    )
  }
}

/** Convert video to MP4. Returns the new path in Supabase storage. */
export async function convertToMp4(videoPath: string, runId: string): Promise<string> {
  const outputPath = videoPath.replace(/\.[^.]+$/, '.mp4')
  const result = await callService<{ mp4Path: string; skipped?: boolean }>('/convert', {
    videoPath,
    runId,
    input: publicInput(videoPath),
    output: await signOutput(outputPath),
  })
  if (result.skipped) console.log('[video-service] Already MP4, skipped conversion')
  else console.log(`[video-service] Converted → ${result.mp4Path}`)
  return result.mp4Path
}

/** Extract frames at timestamps. Returns array of frame paths in Supabase storage. */
export async function extractFrames(videoPath: string, runId: string, timestamps: number[]): Promise<(string | null)[]> {
  // Pre-sign one upload URL per frame. Sequential signing is fine —
  // it's a fast Supabase auth call and N is small (5-10 frames).
  const outputs = await Promise.all(
    timestamps.map((_, i) => signOutput(`runs/${runId}/frame-${i}.jpg`)),
  )
  const result = await callService<{ framePaths: (string | null)[] }>('/extract-frames', {
    videoPath,
    runId,
    timestamps,
    input: publicInput(videoPath),
    outputs,
  })
  console.log(`[video-service] Extracted ${result.framePaths.filter(Boolean).length}/${timestamps.length} frames`)
  return result.framePaths
}

/** Get video duration via ffprobe. */
export async function probeVideo(videoPath: string): Promise<{ durationSeconds: number }> {
  return callService<{ durationSeconds: number }>('/probe', {
    videoPath,
    input: publicInput(videoPath),
  })
}

/** Concatenate audio segments with silence padding for video sync. Returns final audio path. */
export async function concatAudio(
  runId: string,
  segments: { audioPath: string; targetStartTime: number }[],
): Promise<string> {
  const outputPath = `runs/${runId}/voiceover.mp3`
  const result = await callService<{ audioPath: string }>('/concat-audio', {
    runId,
    segments: segments.map((s) => ({
      ...s,
      input: publicInput(s.audioPath),
    })),
    output: await signOutput(outputPath),
  })
  console.log(`[video-service] Concatenated ${segments.length} audio segments → ${result.audioPath}`)
  return result.audioPath
}

/** Trim video to time range. Returns the trimmed video path. */
export async function trimVideo(videoPath: string, runId: string, startTime: number, endTime: number): Promise<string> {
  const outputPath = videoPath.replace(/\.[^.]+$/, '-trimmed.mp4')
  const result = await callService<{ trimmedPath: string }>('/trim', {
    videoPath,
    runId,
    startTime,
    endTime,
    input: publicInput(videoPath),
    output: await signOutput(outputPath),
  })
  return result.trimmedPath
}

/** Mux a silent video with a narration audio track into a single MP4.
 *
 * Server contract:
 *   POST /mux
 *   body: { videoPath, audioPath, runId, input: PublicInput, audioInput: PublicInput, output: SignedOutput }
 *   -> { muxedPath }
 *
 * Server fetches both inputs via plain HTTP (artifacts bucket is
 * public), runs `ffmpeg -i video -i audio -c:v copy -c:a aac -shortest`,
 * PUTs the result to `output.uploadUrl`. */
export async function muxVideoWithAudio(
  videoPath: string,
  audioPath: string,
  runId: string,
): Promise<string> {
  const outputPath = `runs/${runId}/video-with-voiceover.mp4`
  const result = await callService<{ muxedPath: string }>('/mux', {
    videoPath,
    audioPath,
    runId,
    input: publicInput(videoPath),
    audioInput: publicInput(audioPath),
    output: await signOutput(outputPath),
  })
  console.log(`[video-service] Muxed video+audio → ${result.muxedPath}`)
  return result.muxedPath
}

/**
 * Render a Remotion marketing-video composition to MP4. Vercel serverless
 * functions can't host Chromium (Remotion needs ~170 MB), so this work is
 * delegated to the standalone video-service that already runs ffmpeg-heavy
 * jobs.
 *
 * The video-service no longer carries the Supabase service-role key —
 * it receives a signed upload URL (output) per render call. Server
 * pre-bundled site is fetched from `remotionServeUrl`; the manifest
 * is shipped inline (preferred) or fetched from `manifestUrl`.
 */
export async function renderMarketingVideo(input: {
  runId: string
  manifestUrl: string
  manifest?: unknown
  remotionServeUrl: string
  compositionId?: string
  fps?: number
  widthPx?: number
  heightPx?: number
}): Promise<string> {
  const outputPath = `runs/${input.runId}/marketing.mp4`
  const result = await callService<{ videoPath: string }>('/render-marketing-video', {
    runId: input.runId,
    manifestUrl: input.manifestUrl,
    ...(input.manifest !== undefined ? { manifest: input.manifest } : {}),
    compositionId: input.compositionId ?? 'MarketingVideo',
    remotionServeUrl: input.remotionServeUrl,
    fps: input.fps ?? 30,
    widthPx: input.widthPx ?? 1920,
    heightPx: input.heightPx ?? 1080,
    output: await signOutput(outputPath),
  })
  console.log(`[video-service] Rendered marketing video → ${result.videoPath}`)
  return result.videoPath
}
