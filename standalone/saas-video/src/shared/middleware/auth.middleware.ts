import type { Request, Response, NextFunction } from 'express'
import { supabase } from '../db/supabase.client.js'

/**
 * Validates the Supabase JWT and attaches `req.userId` for downstream
 * handlers. Same shape as the Doclee version — kept simple because every
 * authed route here is single-user (no teams, no team-context header).
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.headers.authorization?.replace('Bearer ', '')

  if (!token) {
    res.status(401).json({ error: 'Missing authorization token', code: 'UNAUTHORIZED' })
    return
  }

  const { data, error } = await supabase.auth.getUser(token)

  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' })
    return
  }

  ;(req as Request & { userId: string }).userId = data.user.id
  next()
}

export function getUserId(req: Request): string {
  return (req as Request & { userId: string }).userId
}
