import type { Request, Response, NextFunction } from 'express'
import { supabase } from '../db/supabase.client.js'

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

  // Attach user to request for downstream use
  ;(req as Request & { userId: string }).userId = data.user.id
  next()
}
