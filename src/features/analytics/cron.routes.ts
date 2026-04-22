import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { AppError } from '../../shared/middleware/error.middleware.js'
import { env } from '../../shared/config/env.js'
import { classifyPendingMessages } from './analytics.service.js'

/**
 * Cron routes. Vercel calls these on the schedule defined in vercel.json.
 *
 * Auth: Vercel automatically sets `Authorization: Bearer ${CRON_SECRET}` on
 * every cron invocation. We verify this header so a public POST can't
 * piggyback on the same endpoint to drain the Gemini quota.
 */
export const cronRouter = Router()

function requireCronSecret(req: Request): void {
  const expected = env.CRON_SECRET
  if (!expected) {
    // In production CRON_SECRET is required — env validation already enforces.
    // In dev an unset secret disables the cron endpoint rather than running
    // unauthenticated.
    throw new AppError('Cron not configured', 'CRON_NOT_CONFIGURED', 503)
  }
  const header = req.headers.authorization ?? ''
  const expectedHeader = `Bearer ${expected}`
  if (header !== expectedHeader) {
    throw new AppError('Unauthorized', 'UNAUTHORIZED', 401)
  }
}

cronRouter.post('/classify-messages', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      requireCronSecret(req)
      const result = await classifyPendingMessages()
      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})

// Also expose GET so the operator can check scheduling from the Vercel UI
// without a body. Same auth requirement.
cronRouter.get('/classify-messages', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      requireCronSecret(req)
      const result = await classifyPendingMessages()
      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})
