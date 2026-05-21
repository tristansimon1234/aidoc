import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { getUserId } from '../../shared/middleware/auth.middleware.js'
import { supabase } from '../../shared/db/supabase.client.js'
import { AppError } from '../../shared/middleware/error.middleware.js'

export const profileRouter = Router()

/**
 * GET /api/profile — minimal: just the auth.users row info the UI needs
 * (id, email, created_at). No separate `profiles` table because there's no
 * per-user data beyond what Supabase Auth already carries — credits +
 * brands live in their own tables, and there's nothing else to store yet.
 */
profileRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const { data, error } = await supabase.auth.admin.getUserById(userId)
      if (error || !data.user) {
        throw new AppError('User not found', 'USER_NOT_FOUND', 404)
      }
      res.status(200).json({
        id: data.user.id,
        email: data.user.email,
        createdAt: data.user.created_at,
      })
    } catch (err) { next(err) }
  })()
})
