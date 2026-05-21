import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import { ProjectIdParamSchema } from '../project/project.schema.js'
import { GenerateMarketingVideoOptionsSchema } from './marketing-video.schema.js'
import { enforceQuotaOrThrow } from '../../shared/middleware/quota.middleware.js'
import { incrementUsage, findTeamIdByProjectId } from '../../shared/usage/usage.repository.js'
import { createRun, listMarketingOnlyRunsByProject } from '../run/run.repository.js'
import {
  findMarketingVideoByRunId,
} from './marketing-video.repository.js'
import {
  generateMarketingVideoForRun,
  renderMarketingVideoForRun,
} from './marketing-video.service.js'
import { getProject } from '../project/project.service.js'

/**
 * Standalone marketing-video routes — project-scoped, no doc page required.
 *
 * Mounted at `/projects/:projectId` (alongside the existing page / chat /
 * analytics routers). The complementary run-scoped routes (refine, voice-over
 * tweak, manifest edit, render-only) live in marketing-video.routes.ts and
 * stay there because they key off `runId`, not `projectId`.
 *
 * Flow for the standalone create endpoint:
 *   1. validate the project belongs to the caller (RLS via getProject)
 *   2. quota gate (Free / Founder return 402 when over budget)
 *   3. create a `kind='marketing-only'` run carrying the user's brief
 *   4. fire the existing generate + render pipeline (it reads `brief` when
 *      `run.kind === 'marketing-only'` instead of a doc page)
 *   5. bump usage on success
 *
 * Kept synchronous for now — the project-level UI doesn't need the async
 * job-tracking dance the page-scoped flow uses because there's no page tree
 * to navigate away from. Promote to async + jobs row if the 2-3 min pipeline
 * starts feeling long once we have real usage data.
 */
export const projectMarketingVideoRouter = Router({ mergeParams: true })

const CreateMarketingVideoBodySchema = z.object({
  /** Free-text product description the AI uses to write the script.
   *  Replaces the page.content input of the page-scoped flow. 6000-char
   *  cap matches what the script generator reliably handles. */
  brief: z.string().min(20).max(6000),
  /** Optional human-readable label shown in the marketing-video list. Falls
   *  back to "Marketing video <date>" when omitted. */
  title: z.string().min(1).max(120).optional(),
  /** Voice / music / tone / etc. — same shape as the run-scoped endpoint.
   *  visualMode is force-locked to 'mocks' below because a marketing-only
   *  run has zero screenshots; passing 'screenshots' would yield blank
   *  canvases. */
  options: GenerateMarketingVideoOptionsSchema.optional(),
})

/**
 * POST /projects/:projectId/marketing-video
 * Create a new standalone marketing video from a brief. Synchronous: returns
 * the full summary once the pipeline finishes (script + voice + music +
 * render). Times out at the function's `maxDuration` (300s on Vercel Pro).
 */
projectMarketingVideoRouter.post('/marketing-video', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const params = ProjectIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const body = CreateMarketingVideoBodySchema.safeParse(req.body ?? {})
      if (!body.success) throw new ValidationError(body.error.flatten())

      const userId = (req as Request & { userId: string }).userId
      // getProject runs through the team-membership check — denies access for
      // users who can't see the project. Throws 404/403 which the error
      // middleware translates.
      const project = await getProject(params.data.id, userId)

      const teamId = await findTeamIdByProjectId(project.id)
      if (teamId) await enforceQuotaOrThrow(teamId)

      // Standalone runs have no recording → no startUrl / steps / goal.
      // We still need non-null strings for the columns. The featureName
      // becomes the human-readable label in the marketing list.
      const title = body.data.title?.trim() || `Marketing video ${new Date().toLocaleDateString()}`
      const run = await createRun({
        featureName: title,
        startUrl: project.baseUrl ?? '',
        goal: 'Standalone marketing video',
        kind: 'marketing-only',
        brief: body.data.brief,
        projectId: project.id,
      })

      // Lock visualMode to 'mocks' — no screenshots to animate without a
      // recording. Other options pass through untouched (voice, music, tone).
      const options = {
        ...(body.data.options ?? {}),
        visualMode: 'mocks' as const,
      }

      await generateMarketingVideoForRun(run.id, options)
      const summary = await renderMarketingVideoForRun(run.id)

      if (teamId) {
        try { await incrementUsage(teamId, 'marketing_video') }
        catch (err) { console.warn('[usage] increment marketing_video failed:', (err as Error).message) }
      }

      res.status(201).json({ runId: run.id, title, ...summary })
    } catch (err) {
      next(err)
    }
  })()
})

/**
 * GET /projects/:projectId/marketing-videos
 * List every standalone marketing video for the project, most recent first.
 * Excludes page-scoped marketing videos (those still live on the page's
 * Marketing tab — different surface, different data).
 */
projectMarketingVideoRouter.get('/marketing-videos', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const params = ProjectIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const userId = (req as Request & { userId: string }).userId
      // Membership check — denies enumeration of other teams' videos.
      await getProject(params.data.id, userId)

      const runs = await listMarketingOnlyRunsByProject(params.data.id)
      // Pull the persisted summary alongside each run so the gallery can
      // render thumbnails / status without a second round-trip per item.
      // Sequential is fine: standalone videos are bounded (cap 50) and
      // each lookup is a tiny indexed read.
      const items = await Promise.all(
        runs.map(async (r) => {
          const summary = await findMarketingVideoByRunId(r.id).catch(() => null)
          return {
            runId: r.id,
            title: r.featureName,
            brief: r.brief,
            createdAt: r.createdAt.toISOString(),
            videoUrl: summary?.videoUrl ?? null,
            renderStatus: summary?.renderStatus ?? 'idle',
            thumbnailUrl: summary?.manifest?.thumbnailUrl ?? null,
            durationSeconds: summary?.manifest?.script?.totalDurationSeconds ?? null,
          }
        }),
      )
      res.status(200).json({ items })
    } catch (err) {
      next(err)
    }
  })()
})
