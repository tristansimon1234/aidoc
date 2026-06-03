import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { AppError } from '../../shared/middleware/error.middleware.js'
import { env } from '../../shared/config/env.js'
import { VideoAnalysisCallbackSchema } from './run.schema.js'
import * as runService from './run.service.js'

/**
 * Internal service-to-service routes. Not part of the user-facing API and not
 * behind the JWT auth middleware — authenticated instead by a shared secret
 * that only Doclee and the video-service know.
 *
 * Today this is just the async video-analysis callback: the video-service
 * (Railway) posts the merged, frame-extracted analysis of a long recording
 * back here once it's done, and we persist it + generate the doc + complete
 * the job. See `dispatchAsyncVideoAnalysis` / `finalizeExternalVideoAnalysis`.
 */
export const internalRouter = Router()

function requireCallbackSecret(req: Request): void {
  const expected = env.INTERNAL_CALLBACK_SECRET
  if (!expected) {
    // Unset means the async pipeline was never configured — reject rather than
    // run unauthenticated.
    throw new AppError('Internal callback not configured', 'CALLBACK_NOT_CONFIGURED', 503)
  }
  const header = req.header('x-callback-secret') ?? ''
  // timingSafeEqual needs equal-length buffers; bail on length mismatch first.
  if (header.length !== expected.length) {
    throw new AppError('Unauthorized', 'UNAUTHORIZED', 401)
  }
  if (!timingSafeEqual(Buffer.from(header, 'utf8'), Buffer.from(expected, 'utf8'))) {
    throw new AppError('Unauthorized', 'UNAUTHORIZED', 401)
  }
}

internalRouter.post('/video-analysis-callback', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      requireCallbackSecret(req)
      const payload = VideoAnalysisCallbackSchema.parse(req.body)

      if (!payload.ok) {
        await runService.failExternalVideoAnalysis({
          runId: payload.runId,
          jobId: payload.jobId,
          error: payload.error ?? 'Video analysis failed in the video-service',
        })
        res.status(200).json({ ok: true })
        return
      }

      // Awaits the full finalize (persist → generateDoc → publish → completeJob).
      // This runs in the callback's own fresh serverless invocation, so it has
      // its own 300s budget — independent of the original analyze-video request.
      await runService.finalizeExternalVideoAnalysis({
        runId: payload.runId,
        jobId: payload.jobId,
        triggeredByUserId: payload.triggeredByUserId,
        productName: payload.productName,
        summary: payload.summary,
        videoPath: payload.videoPath,
        steps: payload.steps,
      })

      res.status(200).json({ ok: true })
    } catch (err) {
      next(err)
    }
  })()
})
