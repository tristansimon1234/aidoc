import { findRunById, updateRunSummary } from '../run/run.repository.js'
import type { MarketingVideoSummary } from './marketing-video.types.js'

/**
 * Repository for the marketing-video feature.
 *
 * MVP storage choice: stash everything on `runs.summary_json.marketingVideo`
 * to skip a migration cycle while we validate the creative output. Promotes
 * to a dedicated `marketing_videos` table once we know the data shape, want
 * per-render history, or wire quota / billing.
 */

export async function findMarketingVideoByRunId(
  runId: string,
): Promise<MarketingVideoSummary | null> {
  const run = await findRunById(runId)
  if (!run) return null
  const summary = (run.summaryJson ?? {}) as Record<string, unknown>
  const mv = summary.marketingVideo as MarketingVideoSummary | undefined
  return mv ?? null
}

export async function saveMarketingVideo(
  runId: string,
  marketingVideo: MarketingVideoSummary,
): Promise<void> {
  const run = await findRunById(runId)
  if (!run) throw new Error(`Run not found: ${runId}`)
  const summary = (run.summaryJson ?? {}) as Record<string, unknown>
  await updateRunSummary(runId, {
    ...summary,
    marketingVideo,
  })
}
