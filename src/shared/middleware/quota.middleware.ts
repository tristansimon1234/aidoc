import type { Request, Response, NextFunction } from 'express'
import { AppError } from './error.middleware.js'
import { checkQuota } from '../../features/billing/billing.service.js'

/**
 * Throws a 402 `QUOTA_EXCEEDED` AppError if the given user has hit their plan's
 * monthly budget and their plan does NOT have overage enabled (Free / Startup).
 *
 * Call from anywhere that's about to run a metered op: chat reply, doc gen,
 * voiceover, Try Doc. The check is cheap (two DB reads) and runs before the
 * expensive AI call so we refuse fast.
 */
export async function enforceQuotaOrThrow(userId: string): Promise<void> {
  const status = await checkQuota(userId)
  if (status.allowed) return
  throw new AppError(
    "This project's monthly quota is exhausted. Upgrade the plan to continue.",
    'QUOTA_EXCEEDED',
    402,
  )
}

/**
 * Express middleware wrapper around `enforceQuotaOrThrow`, for routes where the
 * JWT auth middleware has already set `req.userId`. For routes without JWT
 * (widget, public docs), call `enforceQuotaOrThrow(project.userId)` inline.
 */
export function requireQuota(req: Request, _res: Response, next: NextFunction): void {
  void (async () => {
    try {
      const userId = (req as Request & { userId?: string }).userId
      if (!userId) throw new AppError('Missing authenticated user', 'UNAUTHORIZED', 401)
      await enforceQuotaOrThrow(userId)
      next()
    } catch (err) {
      next(err)
    }
  })()
}
