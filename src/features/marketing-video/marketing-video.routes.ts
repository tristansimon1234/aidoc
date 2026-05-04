import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import { RunIdParamSchema } from '../run/run.schema.js'
import { z } from 'zod'
import { GenerateMarketingVideoOptionsSchema, UpdateMarketingManifestSchema, VoiceTonePresetSchema } from './marketing-video.schema.js'
import { enforceQuotaOrThrow } from '../../shared/middleware/quota.middleware.js'
import { incrementUsage, findTeamIdByRunId } from '../../shared/usage/usage.repository.js'
import {
  findMarketingVideoByRunId,
} from './marketing-video.repository.js'
import {
  generateMarketingVideoForRun,
  renderMarketingVideoForRun,
  updateMarketingVoiceoverForRun,
  updateMarketingManifestForRun,
  editMarketingManifestWithAi,
  setMarketingThumbnailForRun,
  MUSIC_PRESETS,
  AI_MUSIC_STYLES,
} from './marketing-video.service.js'

const EditManifestBodySchema = z.object({
  instruction: z.string().min(1).max(2000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).max(20).optional(),
})

const UpdateVoiceoverBodySchema = z.object({
  voiceId: z.string().optional(),
  tone: VoiceTonePresetSchema.optional(),
})
import { getAvailableVoices, isElevenLabsConfigured } from '../../shared/ai/elevenlabs.client.js'

export const marketingVideoRouter = Router()

/**
 * GET /marketing-video/voices
 * List the ElevenLabs voices available to the configured account so the UI
 * can render a picker. Returns an empty array (not 500) when ElevenLabs isn't
 * configured — the UI falls back to the default voice silently.
 */
/**
 * GET /marketing-video/music-presets
 * Returns the configured background-music tracks the UI can offer as a
 * picker. Empty array when no presets are configured (the user can still
 * upload a custom track in that case).
 */
marketingVideoRouter.get('/marketing-video/music-presets', (_req: Request, res: Response, _next: NextFunction) => {
  // Strip nothing — these are public CDN URLs by design (Remotion fetches
  // them from the video-service). Adding tracks doesn't require a
  // migration; the constant is the schema.
  // Edge cache 1h — the preset list is a code-level constant; refreshing
  // it more often than that just adds latency for no signal.
  res.set('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400')
  // Surface the 10 AI music styles alongside any hosted presets. The id
  // prefix `ai-` lets the service route them through ElevenLabs Music
  // generation with a style-specific prompt, vs hosted presets which
  // ship with a static URL.
  const aiStyles = Object.entries(AI_MUSIC_STYLES).map(([id, s]) => ({
    id,
    name: `AI: ${s.name}`,
    mood: s.mood,
    url: '', // generated on-demand via ElevenLabs Music
    aiGenerated: true,
  }))
  res.status(200).json({ presets: [...MUSIC_PRESETS, ...aiStyles] })
})

marketingVideoRouter.get('/marketing-video/voices', (_req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      if (!isElevenLabsConfigured()) {
        res.status(200).json({ voices: [] })
        return
      }
      const voices = await getAvailableVoices()
      // Edge cache 5 min on Vercel + 1h SWR — the voices list rarely
      // changes and is identical for every authed user (same backend
      // API key). Eliminates the ElevenLabs round-trip on every
      // Marketing panel mount after the first one.
      res.set('Cache-Control', 'private, max-age=300, stale-while-revalidate=3600')
      res.status(200).json({ voices })
    } catch (err) {
      next(err)
    }
  })()
})

/**
 * POST /runs/:id/marketing-video
 *
 * Two modes:
 *  - `?async=1` (UI default) — write a row to `jobs` table, respond 202
 *    immediately, run the pipeline in the background. Vercel's
 *    `waitUntil` keeps the function alive past the response so the
 *    pipeline finishes reliably (a plain `void background()` promise
 *    gets killed when the function evicts). The frontend's JobTracker
 *    subscribes to the jobs row via Supabase Realtime and updates when
 *    status flips. User can close the tab / navigate / refresh — the
 *    work continues, the row records the result.
 *  - default (sync) — block the request until the pipeline finishes.
 *    Used by tests / MCP / the marketing CLI script which want a
 *    direct response.
 *
 * waitUntil is bound to the Vercel function's `maxDuration` (300s
 * here) — comfortably covers the typical 2-3 min pipeline.
 */
marketingVideoRouter.post('/:id/marketing-video', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const opts = GenerateMarketingVideoOptionsSchema.safeParse(req.body ?? {})
      if (!opts.success) throw new ValidationError(opts.error.flatten())

      // Quota gate: refuse fast on Free / Founder plans that have hit
      // their monthly token budget. Marketing video is the heaviest single
      // op (600 tokens) so the gate matters. Resolved via the run → project
      // → team chain.
      const teamId = await findTeamIdByRunId(params.data.id)
      if (teamId) await enforceQuotaOrThrow(teamId)

      const isAsync = req.query.async === '1'

      if (!isAsync) {
        // Sync mode: block the request, return the final summary.
        await generateMarketingVideoForRun(params.data.id, opts.data)
        const summary = await renderMarketingVideoForRun(params.data.id)
        // Bump usage AFTER success so a failed pipeline doesn't burn budget.
        if (teamId) {
          try { await incrementUsage(teamId, 'marketing_video') }
          catch (err) { console.warn('[usage] increment marketing_video failed:', (err as Error).message) }
        }
        res.status(200).json(summary)
        return
      }

      // Async mode: track via the jobs table so Realtime can push the
      // result to the frontend even if the user closes the tab.
      const { findRunById } = await import('../run/run.repository.js')
      const { findPageById } = await import('../page/page.repository.js')
      const { updateJobStatus } = await import('../run/job.repository.js')
      const { ensureExclusiveJob, AlreadyRunningError } = await import('../run/job.service.js')

      const run = await findRunById(params.data.id)
      if (!run) {
        res.status(404).json({ error: 'Run not found', code: 'RUN_NOT_FOUND' })
        return
      }
      if (!run.docPageId) {
        res.status(400).json({ error: 'Run has no doc page — cannot track marketing video job', code: 'NO_DOC_PAGE' })
        return
      }
      const page = await findPageById(run.docPageId)
      if (!page) {
        res.status(404).json({ error: 'Doc page not found', code: 'PAGE_NOT_FOUND' })
        return
      }

      let jobId: string | null = null
      try {
        // ensureExclusiveJob auto-reclaims jobs older than 10min (Vercel
        // timeout / crashed-mid-flight) so a stale "running" row doesn't
        // permanently lock the page. createJob alone left users stuck on
        // JOB_ALREADY_RUNNING for jobs that died ages ago.
        const job = await ensureExclusiveJob({
          runId: params.data.id,
          pageId: run.docPageId,
          projectId: page.projectId,
          type: 'marketing-video',
          triggeredByUserId: (req as Request & { userId?: string }).userId ?? null,
        })
        jobId = job.id
      } catch (err) {
        if (err instanceof AlreadyRunningError) {
          res.status(409).json({
            error: 'A marketing-video generation is already running for this page.',
            code: 'JOB_ALREADY_RUNNING',
            details: err.running,
          })
          return
        }
        res.status(500).json({
          error: 'Failed to start marketing-video job',
          code: 'JOB_CREATE_FAILED',
          details: (err as Error).message ?? '',
        })
        return
      }

      res.status(202).json({ runId: params.data.id, jobId, status: 'running' })

      // Critical: register the background promise with Vercel's
      // `waitUntil` so the function stays alive until the pipeline
      // completes. Without this the function gets evicted right after
      // res.json() and the work dies in the middle.
      const { waitUntil } = await import('@vercel/functions')
      waitUntil((async () => {
        try {
          await generateMarketingVideoForRun(params.data.id, opts.data)
          await renderMarketingVideoForRun(params.data.id)
          // Bump usage only AFTER the full pipeline succeeds — a failed
          // render shouldn't burn the user's budget.
          if (teamId) {
            try { await incrementUsage(teamId, 'marketing_video') }
            catch (err) { console.warn('[usage] increment marketing_video failed:', (err as Error).message) }
          }
          if (jobId) await updateJobStatus(jobId, 'completed').catch(() => {})
        } catch (err) {
          const message = (err as Error).message
          console.error(`[marketing-video] Background pipeline failed for ${params.data.id}: ${message}`)
          if (jobId) await updateJobStatus(jobId, 'failed', message).catch(() => {})
        }
      })())
    } catch (err) {
      next(err)
    }
  })()
})

/**
 * POST /runs/:id/marketing-video/render
 * Trigger a render of the existing manifest via the video-service. Use
 * after iterating on the script — separate endpoint so you don't burn a
 * render every time you tweak the manifest.
 *
 * Synchronous: returns once the MP4 is uploaded (or the render fails and
 * the summary is marked accordingly). Vercel's 300s function cap is the
 * outer bound; a 60s 1080p video typically takes 2-5 min.
 */
/**
 * POST /runs/:id/marketing-video/voiceover
 * Re-synthesize JUST the voice-over with a new voice / tone, leaving
 * the script + screenshots + music untouched. Resets render status to
 * 'idle' so the UI prompts a fresh render.
 */
marketingVideoRouter.post('/:id/marketing-video/voiceover', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const body = UpdateVoiceoverBodySchema.safeParse(req.body ?? {})
      if (!body.success) throw new ValidationError(body.error.flatten())

      const summary = await updateMarketingVoiceoverForRun(params.data.id, body.data)
      res.status(200).json(summary)
    } catch (err) {
      next(err)
    }
  })()
})

/**
 * PUT /runs/:id/marketing-video/manifest
 * Persist a user-edited manifest. Lets the operator iterate on the
 * rendering (tweak headlines, scene durations, mockCode, branding,
 * music volume) without re-running Gemini + ElevenLabs. Voice-over /
 * music URLs stay frozen — re-synthesize voice via the dedicated
 * /voiceover endpoint, change music via a fresh /marketing-video call.
 *
 * Resets renderStatus to 'idle' on success so the UI prompts a
 * re-render with the new manifest.
 */
marketingVideoRouter.put('/:id/marketing-video/manifest', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const body = UpdateMarketingManifestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const summary = await updateMarketingManifestForRun(params.data.id, body.data)
      res.status(200).json(summary)
    } catch (err) {
      next(err)
    }
  })()
})

/**
 * POST /runs/:id/marketing-video/edit
 * Chat-style manifest edits: user describes a change in plain language
 * ("shorten scene 2 by 2s", "switch accent to blue") and the AI returns
 * the updated manifest + a one-line summary of what it changed. Quota
 * gated up-front because the underlying Gemini Pro call is metered.
 */
marketingVideoRouter.post('/:id/marketing-video/edit', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const body = EditManifestBodySchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const teamId = await findTeamIdByRunId(params.data.id)
      if (teamId) await enforceQuotaOrThrow(teamId)

      // Background job — same pattern as /generate-marketing. The combined
      // edit (Gemini Pro) + per-scene rescue (1 Pro call per failure) +
      // render (Remotion) can exceed 300s on slow days; we don't want the
      // refine to die mid-flight and we don't want the user blocked on
      // the request. The frontend listens via useJobs realtime + flips
      // the loader off when the job completes.
      const { findRunById } = await import('../run/run.repository.js')
      const { findPageById } = await import('../page/page.repository.js')
      const { updateJobStatus } = await import('../run/job.repository.js')
      const { ensureExclusiveJob, AlreadyRunningError } = await import('../run/job.service.js')

      const run = await findRunById(params.data.id)
      if (!run) {
        res.status(404).json({ error: 'Run not found', code: 'RUN_NOT_FOUND' })
        return
      }
      if (!run.docPageId) {
        res.status(400).json({ error: 'Run has no doc page — cannot track marketing video edit job', code: 'NO_DOC_PAGE' })
        return
      }
      const page = await findPageById(run.docPageId)
      if (!page) {
        res.status(404).json({ error: 'Doc page not found', code: 'PAGE_NOT_FOUND' })
        return
      }

      let jobId: string | null = null
      try {
        // ensureExclusiveJob auto-reclaims stale jobs >10min old, so a
        // dead refine doesn't permanently lock the page.
        const job = await ensureExclusiveJob({
          runId: params.data.id,
          pageId: run.docPageId,
          projectId: page.projectId,
          // Reuse 'marketing-video' so the per-page UNIQUE WHERE running
          // index blocks concurrent generates AND refines on the same
          // page — we never want both racing for the manifest.
          type: 'marketing-video',
          triggeredByUserId: (req as Request & { userId?: string }).userId ?? null,
        })
        jobId = job.id
      } catch (err) {
        if (err instanceof AlreadyRunningError) {
          res.status(409).json({
            error: 'A marketing-video operation is already running for this page.',
            code: 'JOB_ALREADY_RUNNING',
            details: err.running,
          })
          return
        }
        res.status(500).json({
          error: 'Failed to start marketing-video edit job',
          code: 'JOB_CREATE_FAILED',
          details: (err as Error).message ?? '',
        })
        return
      }

      res.status(202).json({ runId: params.data.id, jobId, status: 'running' })

      const { waitUntil } = await import('@vercel/functions')
      waitUntil((async () => {
        try {
          await editMarketingManifestWithAi(params.data.id, body.data)
          await renderMarketingVideoForRun(params.data.id)
          if (jobId) await updateJobStatus(jobId, 'completed').catch(() => {})
        } catch (err) {
          const message = (err as Error).message
          console.error(`[marketing-edit] Background pipeline failed for ${params.data.id}: ${message}`)
          if (jobId) await updateJobStatus(jobId, 'failed', message).catch(() => {})
        }
      })())
    } catch (err) {
      next(err)
    }
  })()
})

marketingVideoRouter.post('/:id/marketing-video/render', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const summary = await renderMarketingVideoForRun(params.data.id)
      res.status(200).json(summary)
    } catch (err) {
      next(err)
    }
  })()
})

/**
 * POST /runs/:id/marketing-video/thumbnail
 * Persist a JPEG thumbnail (captured client-side from the rendered video
 * at ~4s into the hook). Stored as a side artifact; the manifest's
 * thumbnailUrl is updated. Used as the player's poster, og:image, and
 * social card. Body: { jpegBase64: string } (data URL or raw base64).
 */
const ThumbnailBodySchema = z.object({
  jpegBase64: z.string().min(100).max(4_000_000),
})
marketingVideoRouter.post('/:id/marketing-video/thumbnail', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = ThumbnailBodySchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const result = await setMarketingThumbnailForRun(params.data.id, body.data.jpegBase64)
      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})

/**
 * GET /runs/:id/marketing-video
 * Read the persisted manifest if one exists. Returns 404 when the run has
 * no marketing video yet.
 */
marketingVideoRouter.get('/:id/marketing-video', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const summary = await findMarketingVideoByRunId(params.data.id)
      if (!summary) {
        res.status(404).json({
          error: 'No marketing video for this run yet',
          code: 'MARKETING_VIDEO_NOT_FOUND',
        })
        return
      }
      res.status(200).json(summary)
    } catch (err) {
      next(err)
    }
  })()
})
