import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import { RunIdParamSchema } from '../run/run.schema.js'
import { GenerateMarketingVideoOptionsSchema } from './marketing-video.schema.js'
import {
  findMarketingVideoByRunId,
} from './marketing-video.repository.js'
import {
  generateMarketingVideoForRun,
  renderMarketingVideoForRun,
} from './marketing-video.service.js'
import { getAvailableVoices, isElevenLabsConfigured } from '../../shared/ai/elevenlabs.client.js'

export const marketingVideoRouter = Router()

/**
 * GET /marketing-video/voices
 * List the ElevenLabs voices available to the configured account so the UI
 * can render a picker. Returns an empty array (not 500) when ElevenLabs isn't
 * configured — the UI falls back to the default voice silently.
 */
marketingVideoRouter.get('/marketing-video/voices', (_req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      if (!isElevenLabsConfigured()) {
        res.status(200).json({ voices: [] })
        return
      }
      const voices = await getAvailableVoices()
      res.status(200).json({ voices })
    } catch (err) {
      next(err)
    }
  })()
})

/**
 * POST /runs/:id/marketing-video
 * Generate (or regenerate) the marketing-video manifest for a run. Returns
 * the freshly built MarketingVideoSummary including the manifest URL.
 *
 * MVP cost note: a run with `withVoiceover: true` (default) will burn
 * one ElevenLabs synthesis per call (~€0.30). Pass `withVoiceover: false`
 * for template-iteration runs where you only need the script + screenshots.
 */
marketingVideoRouter.post('/:id/marketing-video', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const opts = GenerateMarketingVideoOptionsSchema.safeParse(req.body ?? {})
      if (!opts.success) throw new ValidationError(opts.error.flatten())

      const summary = await generateMarketingVideoForRun(params.data.id, opts.data)
      res.status(200).json(summary)
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
