import type { Request, Response, NextFunction } from 'express'
import { isAdminEmail } from '../config/env.js'
import { findAuthUserEmail } from '../../features/profile/profile.repository.js'

/**
 * Gate any admin-only route. Must run after `authMiddleware` (needs req.userId).
 * Looks up the user's email via Supabase admin API and compares against the
 * `ADMIN_EMAILS` env allow-list.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = (req as Request & { userId?: string }).userId
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' })
    return
  }

  const email = await findAuthUserEmail(userId)
  if (!isAdminEmail(email)) {
    res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' })
    return
  }

  next()
}
