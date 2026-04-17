import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import { supabase } from '../../shared/db/supabase.client.js'
import { UpdateProfileSchema } from './profile.schema.js'
import * as profileService from './profile.service.js'

export const profileRouter = Router()

function getUserId(req: Request): string {
  return (req as Request & { userId: string }).userId
}

async function getUserEmail(userId: string): Promise<string | null> {
  const { data } = await supabase.auth.admin.getUserById(userId)
  return data.user?.email ?? null
}

profileRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const email = await getUserEmail(userId)
      const profile = await profileService.getOrCreateProfile(userId, email)
      res.status(200).json(profile)
    } catch (err) {
      next(err)
    }
  })()
})

profileRouter.patch('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const parsed = UpdateProfileSchema.safeParse(req.body)
      if (!parsed.success) throw new ValidationError(parsed.error.flatten())
      const profile = await profileService.updateProfile(getUserId(req), parsed.data)
      res.status(200).json(profile)
    } catch (err) {
      next(err)
    }
  })()
})
