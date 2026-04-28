import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import { RunIdParamSchema } from '../run/run.schema.js'
import { z } from 'zod'
import { GenerateMarketingVideoOptionsSchema, VoiceTonePresetSchema } from './marketing-video.schema.js'
import {
  findMarketingVideoByRunId,
} from './marketing-video.repository.js'
import {
  generateMarketingVideoForRun,
  renderMarketingVideoForRun,
  updateMarketingVoiceoverForRun,
  MUSIC_PRESETS,
} from './marketing-video.service.js'

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
  res.status(200).json({ presets: MUSIC_PRESETS })
})

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
 *
 * Synchronous end-to-end pipeline (script → voice → music → render).
 * The full request blocks for ~2-3 min — well within the
 * `maxDuration: 300` configured for the API function in vercel.json.
 *
 * Why sync, not background-with-202: Vercel kills serverless functions
 * after the response is sent. A `void background()` promise sometimes
 * runs to completion, but for a 2-3 min pipeline it doesn't. The
 * "fire-and-forget + jobs table + Realtime" pattern only works
 * reliably with @vercel/functions waitUntil or an external worker —
 * neither is in scope here.
 *
 * Frontend-side, the JobContext addJob/updateJob/failJob still
 * provides the bottom-right card; it's just driven by the synchronous
 * request completing rather than a Realtime push.
 */
marketingVideoRouter.post('/:id/marketing-video', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const opts = GenerateMarketingVideoOptionsSchema.safeParse(req.body ?? {})
      if (!opts.success) throw new ValidationError(opts.error.flatten())

      // Step 1: build the manifest (Gemini + ElevenLabs + maybe music).
      await generateMarketingVideoForRun(params.data.id, opts.data)

      // Step 2: render to MP4 via the video-service. This is the long
      // pole (60-180s) — chained inside the same HTTP request so the
      // frontend gets a single complete response.
      const summary = await renderMarketingVideoForRun(params.data.id)

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
