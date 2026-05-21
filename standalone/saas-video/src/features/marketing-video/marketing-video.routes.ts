import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { ValidationError, NotFoundError, QuotaExceededError } from '../../shared/middleware/error.middleware.js'
import { getUserId } from '../../shared/middleware/auth.middleware.js'
import { GenerateMarketingVideoOptionsSchema, VoiceTonePresetSchema, UpdateMarketingManifestSchema } from './marketing-video.schema.js'
import {
  createMarketingVideo,
  findMarketingVideoById,
  getMarketingVideoById,
  listMarketingVideosForUser,
  updateMarketingVideo,
  deleteMarketingVideo,
  toSummary,
} from './marketing-video.repository.js'
import {
  generateMarketingVideo,
  renderMarketingVideoForRun,
  updateMarketingVoiceoverForRun,
  updateMarketingManifestForRun,
  editMarketingManifestWithAi,
  setMarketingThumbnailForRun,
  MUSIC_PRESETS,
  AI_MUSIC_STYLES,
} from './marketing-video.service.js'
import { findBrandById, findDefaultBrandForUser } from '../brand/brand.repository.js'
import { spendCredit, refundCredit } from '../credits/credits.repository.js'
import { getAvailableVoices, isElevenLabsConfigured } from '../../shared/ai/elevenlabs.client.js'

export const marketingVideoRouter = Router()

const CreateBodySchema = z.object({
  brief: z.string().min(20).max(6000),
  title: z.string().min(1).max(120).optional(),
  brandId: z.string().uuid().optional(),
  options: GenerateMarketingVideoOptionsSchema.optional(),
})

const IdParamSchema = z.object({ id: z.string().uuid() })

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

const ThumbnailBodySchema = z.object({
  jpegBase64: z.string().min(100).max(4_000_000),
})

function ensureOwnership(video: { userId: string }, userId: string): void {
  if (video.userId !== userId) {
    throw new NotFoundError('Marketing video')
  }
}

/**
 * GET /api/marketing-videos
 * List the current user's marketing videos, most recent first.
 */
marketingVideoRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const videos = await listMarketingVideosForUser(userId)
      res.status(200).json({
        items: videos.map((v) => ({
          id: v.id,
          title: v.title,
          brief: v.brief,
          brandId: v.brandId,
          videoUrl: v.videoUrl,
          thumbnailUrl: v.thumbnailUrl,
          renderStatus: v.renderStatus,
          renderError: v.renderError,
          createdAt: v.createdAt.toISOString(),
          // Surface the script duration alongside each row so the gallery
          // can show "45s" without round-tripping for the full manifest.
          durationSeconds: v.manifest?.script?.totalDurationSeconds ?? null,
        })),
      })
    } catch (err) { next(err) }
  })()
})

/**
 * POST /api/marketing-videos
 * Create + generate a new marketing video. Synchronous: blocks until the
 * pipeline finishes (script → voice → music → render). Credit is spent up
 * front and refunded automatically on pipeline failure.
 */
marketingVideoRouter.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const body = CreateBodySchema.safeParse(req.body ?? {})
      if (!body.success) throw new ValidationError(body.error.flatten())

      // Resolve the brand: explicit brandId wins, otherwise fall back to the
      // user's default. Reject early if neither is available — UX should
      // never let the user reach this state but it's the kind of thing a
      // hand-crafted curl can hit.
      const brand = body.data.brandId
        ? await findBrandById(body.data.brandId)
        : await findDefaultBrandForUser(userId)
      if (!brand) throw new NotFoundError('Brand')
      if (brand.userId !== userId) throw new NotFoundError('Brand')

      // Spend the credit BEFORE creating the row — keeps the user from
      // racing two parallel creates on the last credit. Refunded below
      // if anything in the pipeline throws.
      const balanceAfter = await spendCredit(userId)
      if (balanceAfter === null) {
        throw new QuotaExceededError('No credits remaining. Buy a credit pack to keep generating.')
      }

      let videoId: string | null = null
      try {
        const title = body.data.title?.trim() || `Marketing video ${new Date().toLocaleDateString()}`
        const video = await createMarketingVideo({
          userId,
          brandId: brand.id,
          title,
          brief: body.data.brief,
        })
        videoId = video.id

        await generateMarketingVideo(video.id, body.data.options ?? {})
        const summary = await renderMarketingVideoForRun(video.id)
        const updated = await getMarketingVideoById(video.id)
        res.status(201).json({
          id: updated.id,
          title: updated.title,
          ...summary,
        })
      } catch (err) {
        // Refund the credit on any failure inside the pipeline. We don't
        // refund a user who burnt the credit by cancelling mid-flight
        // (the abort would land here too) — that's a tradeoff worth the
        // simpler accounting model.
        try { await refundCredit(userId) } catch { /* best-effort */ }
        if (videoId) {
          try {
            await updateMarketingVideo(videoId, {
              renderStatus: 'failed',
              renderError: (err as Error).message,
            })
          } catch { /* best-effort */ }
        }
        throw err
      }
    } catch (err) { next(err) }
  })()
})

/**
 * GET /api/marketing-videos/:id
 * Full detail including the persisted manifest.
 */
marketingVideoRouter.get('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const params = IdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const video = await findMarketingVideoById(params.data.id)
      if (!video) throw new NotFoundError('Marketing video')
      ensureOwnership(video, userId)

      res.status(200).json({
        id: video.id,
        title: video.title,
        brief: video.brief,
        brandId: video.brandId,
        createdAt: video.createdAt.toISOString(),
        // Summary carries renderStatus / renderError / videoUrl / manifest —
        // spread last so those win over any older fields if we ever add them.
        ...toSummary(video),
      })
    } catch (err) { next(err) }
  })()
})

/**
 * DELETE /api/marketing-videos/:id
 */
marketingVideoRouter.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const params = IdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const video = await getMarketingVideoById(params.data.id)
      ensureOwnership(video, userId)

      await deleteMarketingVideo(params.data.id)
      res.status(204).end()
    } catch (err) { next(err) }
  })()
})

/**
 * POST /api/marketing-videos/:id/edit
 * Chat-style AI refinement on top of the existing manifest. Costs 0 credits
 * — it's an iteration on an already-paid-for video. (We may revisit if
 * abuse becomes a problem.)
 */
marketingVideoRouter.post('/:id/edit', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const params = IdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = EditManifestBodySchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const video = await getMarketingVideoById(params.data.id)
      ensureOwnership(video, userId)

      const result = await editMarketingManifestWithAi(video.id, body.data)
      // Auto re-render after AI edit — same UX as Doclee.
      await renderMarketingVideoForRun(video.id)
      res.status(200).json(result)
    } catch (err) { next(err) }
  })()
})

/**
 * POST /api/marketing-videos/:id/render
 * Re-render the existing manifest (use after manifest edits that didn't
 * auto-render). No credit cost.
 */
marketingVideoRouter.post('/:id/render', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const params = IdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const video = await getMarketingVideoById(params.data.id)
      ensureOwnership(video, userId)

      const summary = await renderMarketingVideoForRun(video.id)
      res.status(200).json(summary)
    } catch (err) { next(err) }
  })()
})

/**
 * POST /api/marketing-videos/:id/voiceover
 * Re-synthesize just the voice (different voice / tone) without re-running
 * the whole pipeline.
 */
marketingVideoRouter.post('/:id/voiceover', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const params = IdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = UpdateVoiceoverBodySchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const video = await getMarketingVideoById(params.data.id)
      ensureOwnership(video, userId)

      const summary = await updateMarketingVoiceoverForRun(video.id, body.data)
      res.status(200).json(summary)
    } catch (err) { next(err) }
  })()
})

/**
 * PUT /api/marketing-videos/:id/manifest
 * Persist a user-edited manifest. Resets renderStatus to 'idle' so the UI
 * prompts a fresh render.
 */
marketingVideoRouter.put('/:id/manifest', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const params = IdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = UpdateMarketingManifestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const video = await getMarketingVideoById(params.data.id)
      ensureOwnership(video, userId)

      const summary = await updateMarketingManifestForRun(video.id, body.data)
      res.status(200).json(summary)
    } catch (err) { next(err) }
  })()
})

/**
 * POST /api/marketing-videos/:id/thumbnail
 * Persist a JPEG thumbnail (captured client-side from the rendered video).
 */
marketingVideoRouter.post('/:id/thumbnail', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const params = IdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = ThumbnailBodySchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const video = await getMarketingVideoById(params.data.id)
      ensureOwnership(video, userId)

      const result = await setMarketingThumbnailForRun(video.id, body.data.jpegBase64)
      res.status(200).json(result)
    } catch (err) { next(err) }
  })()
})

/**
 * Static config — voices + music presets. Public-ish (still authed but
 * doesn't leak per-user data) so we cache aggressively at the edge.
 */
marketingVideoRouter.get('/_config/voices', (_req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      if (!isElevenLabsConfigured()) {
        res.status(200).json({ voices: [] })
        return
      }
      const voices = await getAvailableVoices()
      res.set('Cache-Control', 'private, max-age=300, stale-while-revalidate=3600')
      res.status(200).json({ voices })
    } catch (err) { next(err) }
  })()
})

marketingVideoRouter.get('/_config/music-presets', (_req: Request, res: Response): void => {
  res.set('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400')
  const aiStyles = Object.entries(AI_MUSIC_STYLES).map(([id, s]) => ({
    id,
    name: `AI: ${s.name}`,
    mood: s.mood,
    url: '',
    aiGenerated: true,
  }))
  res.status(200).json({ presets: [...MUSIC_PRESETS, ...aiStyles] })
})
