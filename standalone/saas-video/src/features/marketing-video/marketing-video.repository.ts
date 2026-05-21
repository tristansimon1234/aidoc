import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError, NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { MarketingManifest, MarketingVideoSummary, MarketingVideoRenderStatus } from './marketing-video.types.js'

/**
 * Repository for marketing_videos rows.
 *
 * Replaces Doclee's `runs.summary_json.marketingVideo` JSONB-nested pattern
 * with a first-class table. Each video has its own row; the manifest lives
 * in a dedicated `manifest jsonb` column rather than buried inside a
 * generic run summary, which makes the gallery query trivial and dodges
 * the JSONB read-modify-write hazard of the old upsert pattern.
 */

export interface MarketingVideoRow {
  id: string
  user_id: string
  brand_id: string
  title: string
  brief: string
  manifest: MarketingManifest | null
  video_url: string | null
  video_path: string | null
  thumbnail_url: string | null
  thumbnail_path: string | null
  render_status: MarketingVideoRenderStatus | 'pending'
  render_error: string | null
  created_at: string
  updated_at: string
}

export interface MarketingVideo {
  id: string
  userId: string
  brandId: string
  title: string
  brief: string
  manifest: MarketingManifest | null
  videoUrl: string | null
  videoPath: string | null
  thumbnailUrl: string | null
  thumbnailPath: string | null
  renderStatus: MarketingVideoRenderStatus | 'pending'
  renderError: string | null
  createdAt: Date
  updatedAt: Date
}

function mapRow(row: MarketingVideoRow): MarketingVideo {
  return {
    id: row.id,
    userId: row.user_id,
    brandId: row.brand_id,
    title: row.title,
    brief: row.brief,
    manifest: row.manifest,
    videoUrl: row.video_url,
    videoPath: row.video_path,
    thumbnailUrl: row.thumbnail_url,
    thumbnailPath: row.thumbnail_path,
    renderStatus: row.render_status,
    renderError: row.render_error,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export async function createMarketingVideo(input: {
  userId: string
  brandId: string
  title: string
  brief: string
}): Promise<MarketingVideo> {
  const { data, error } = await supabase
    .from('marketing_videos')
    .insert({
      user_id: input.userId,
      brand_id: input.brandId,
      title: input.title,
      brief: input.brief,
      render_status: 'pending',
    })
    .select('*')
    .single()
  if (error) {
    // The partial unique index on (user_id) WHERE render_status IN
    // ('generating','rendering') will surface as a Postgres unique-violation
    // when the user already has a pipeline in flight. Translate it to a
    // clean error rather than a 500.
    if (error.code === '23505' && error.message.includes('one_in_flight_per_user')) {
      throw new DatabaseError(
        'A marketing video is already in flight for this user. Wait for it to finish before starting another.',
      )
    }
    throw new DatabaseError(error.message)
  }
  return mapRow(data as MarketingVideoRow)
}

export async function findMarketingVideoById(id: string): Promise<MarketingVideo | null> {
  const { data, error } = await supabase
    .from('marketing_videos')
    .select('*')
    .eq('id', id)
    .single()
  if (error && error.code === 'PGRST116') return null
  if (error) throw new DatabaseError(error.message)
  return data ? mapRow(data as MarketingVideoRow) : null
}

export async function getMarketingVideoById(id: string): Promise<MarketingVideo> {
  const video = await findMarketingVideoById(id)
  if (!video) throw new NotFoundError('Marketing video')
  return video
}

export async function listMarketingVideosForUser(userId: string, limit = 50): Promise<MarketingVideo[]> {
  const { data, error } = await supabase
    .from('marketing_videos')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new DatabaseError(error.message)
  return (data as MarketingVideoRow[]).map(mapRow)
}

/** Patch any subset of fields. Used by every pipeline stage to advance
 *  render_status, persist the manifest, set the video URL once rendered,
 *  capture an error, etc. */
export async function updateMarketingVideo(
  id: string,
  patch: Partial<{
    title: string
    manifest: MarketingManifest
    videoUrl: string | null
    videoPath: string | null
    thumbnailUrl: string | null
    thumbnailPath: string | null
    renderStatus: MarketingVideoRenderStatus | 'pending'
    renderError: string | null
  }>,
): Promise<MarketingVideo> {
  const row: Record<string, unknown> = {}
  if (patch.title !== undefined) row.title = patch.title
  if (patch.manifest !== undefined) row.manifest = patch.manifest
  if (patch.videoUrl !== undefined) row.video_url = patch.videoUrl
  if (patch.videoPath !== undefined) row.video_path = patch.videoPath
  if (patch.thumbnailUrl !== undefined) row.thumbnail_url = patch.thumbnailUrl
  if (patch.thumbnailPath !== undefined) row.thumbnail_path = patch.thumbnailPath
  if (patch.renderStatus !== undefined) row.render_status = patch.renderStatus
  if (patch.renderError !== undefined) row.render_error = patch.renderError

  const { data, error } = await supabase
    .from('marketing_videos')
    .update(row)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapRow(data as MarketingVideoRow)
}

export async function deleteMarketingVideo(id: string): Promise<void> {
  const { error } = await supabase.from('marketing_videos').delete().eq('id', id)
  if (error) throw new DatabaseError(error.message)
}

/** Returns a `MarketingVideoSummary` (the shape the existing service code
 *  reads from) built from a row. Lets callers that previously used
 *  `findMarketingVideoByRunId` keep the same shape.
 *
 *  The manifest stored in `manifest jsonb` carries every voice/music/script
 *  field the renderer needs; we expose a separate `manifestUrl` by
 *  re-uploading the manifest as JSON to storage (the render service fetches
 *  it by URL). That URL is reconstructed deterministically from the videoId
 *  here so callers don't need to track it separately. */
export function toSummary(video: MarketingVideo): MarketingVideoSummary {
  if (!video.manifest) {
    return {
      manifest: null as unknown as MarketingManifest,
      manifestUrl: null,
      videoUrl: video.videoUrl,
      videoPath: video.videoPath,
      renderStatus: video.renderStatus === 'pending' ? 'idle' : video.renderStatus,
      renderError: video.renderError,
    }
  }
  return {
    manifest: video.manifest,
    manifestUrl: null,
    videoUrl: video.videoUrl,
    videoPath: video.videoPath,
    renderStatus: video.renderStatus === 'pending' ? 'idle' : video.renderStatus,
    renderError: video.renderError,
  }
}

// ============================================================
// Compatibility shims for code ported from Doclee
// ============================================================
// The original service was written against a runId-keyed JSONB nested
// persistence model. To minimise diff churn during the extraction we keep
// these helper signatures and adapt them onto the new table. They can be
// inlined / removed once the service is fully cleaned up.

/** Drop-in replacement for the old `findMarketingVideoByRunId`. Returns the
 *  same `MarketingVideoSummary` shape so call sites don't need to change. */
export async function findMarketingVideoByRunId(
  videoId: string,
): Promise<MarketingVideoSummary | null> {
  const video = await findMarketingVideoById(videoId)
  if (!video || !video.manifest) return null
  return toSummary(video)
}

/** Drop-in replacement for the old `saveMarketingVideo(runId, summary)`.
 *  Persists every field on the row that the summary carries. */
export async function saveMarketingVideo(
  videoId: string,
  summary: MarketingVideoSummary,
): Promise<void> {
  // renderStatus 'idle' is the DB-level 'pending' equivalent — we keep the
  // 'pending' label for rows that have never started a pipeline. Anything
  // else maps 1:1.
  const dbStatus = summary.renderStatus === 'idle' ? 'pending' : summary.renderStatus
  await updateMarketingVideo(videoId, {
    manifest: summary.manifest,
    videoUrl: summary.videoUrl,
    videoPath: summary.videoPath,
    renderStatus: dbStatus,
    renderError: summary.renderError,
  })
}
