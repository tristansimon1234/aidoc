import type { Request, Response, NextFunction } from 'express'
import { AppError } from './error.middleware.js'
import { checkQuota } from '../../features/billing/billing.service.js'
import { resolveActiveTeam } from './team-context.middleware.js'

/**
 * Throws a 402 `QUOTA_EXCEEDED` AppError if the given team has hit its plan's
 * monthly budget and the plan does NOT have overage enabled (Free / Startup).
 *
 * Call from anywhere that's about to run a metered op: chat reply, doc gen,
 * voiceover, Try Doc. The check is cheap (two DB reads) and runs before the
 * expensive AI call so we refuse fast.
 *
 * Accepts a teamId since subscriptions are team-scoped.
 */
export async function enforceQuotaOrThrow(teamId: string): Promise<void> {
  const status = await checkQuota(teamId)
  if (status.allowed) return
  throw new AppError(
    "This team's monthly quota is exhausted. Upgrade the plan to continue.",
    'QUOTA_EXCEEDED',
    402,
  )
}

/**
 * Express middleware wrapper, for routes where the JWT auth middleware has
 * already set `req.userId` and the team context is resolvable from X-Team-Id
 * / personal team fallback. For project-scoped routes (the common case), you
 * should instead call `enforceQuotaOrThrow(teamId)` inline after resolving
 * the team from the project.
 */
export function requireQuota(req: Request, _res: Response, next: NextFunction): void {
  void (async () => {
    try {
      const userId = (req as Request & { userId?: string }).userId
      if (!userId) throw new AppError('Missing authenticated user', 'UNAUTHORIZED', 401)
      const teamId = await resolveActiveTeam(req, userId)
      await enforceQuotaOrThrow(teamId)
      next()
    } catch (err) {
      next(err)
    }
  })()
}
