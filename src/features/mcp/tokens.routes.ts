import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { AppError, ValidationError } from '../../shared/middleware/error.middleware.js'
import { CreateMcpTokenSchema } from './mcp.schema.js'
import * as mcpRepo from './mcp.repository.js'

export const mcpTokensRouter = Router()

function getUserId(req: Request): string {
  return (req as Request & { userId: string }).userId
}

const TokenIdParam = z.object({ id: z.string().uuid() })

/** Window during which a rotated token's old value remains valid. Long enough
 *  to give a user time to swap the token in their MCP client without breaking
 *  a session in flight; short enough that a leaked old value isn't a free
 *  pass. */
const ROTATION_GRACE_HOURS = 24

function generateTokenValue(): string {
  return `aidoc_usr_${randomBytes(32).toString('hex')}`
}

mcpTokensRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const tokens = await mcpRepo.listTokensForUser(userId)
      res.status(200).json(tokens)
    } catch (err) {
      next(err)
    }
  })()
})

mcpTokensRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const parsed = CreateMcpTokenSchema.safeParse(req.body)
      if (!parsed.success) throw new ValidationError(parsed.error.flatten())
      const userId = getUserId(req)

      // Must be a member of the target team — we don't restrict to owner
      // because role only gates team management today; project access is
      // identical for members and owners.
      const { findMember } = await import('../team/team.repository.js')
      const member = await findMember(parsed.data.teamId, userId)
      if (!member) throw new AppError('Not a member of this workspace', 'FORBIDDEN', 403)

      const tokenValue = generateTokenValue()
      const expiresAt = parsed.data.expiresInDays
        ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
        : null
      const created = await mcpRepo.createToken({
        userId,
        teamId: parsed.data.teamId,
        name: parsed.data.name,
        token: tokenValue,
        scope: parsed.data.scope ?? 'admin',
        expiresAt,
      })

      // Return the full token ONCE — this is the only moment it's visible.
      res.status(201).json({
        id: created.id,
        userId: created.userId,
        teamId: created.teamId,
        name: created.name,
        token: created.token,
        preview: created.token.slice(-4),
        scope: created.scope,
        lastUsedAt: created.lastUsedAt,
        lastUsedIp: created.lastUsedIp,
        expiresAt: created.expiresAt,
        revokedAt: created.revokedAt,
        createdAt: created.createdAt,
      })
    } catch (err) {
      next(err)
    }
  })()
})

/** Rotate a token: mints a new value with the same scope/expiry, and schedules
 *  the old token to expire after a grace window so a session in flight isn't
 *  cut mid-call. The new token is returned in the same shape as POST /. */
mcpTokensRouter.post('/:id/rotate', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = TokenIdParam.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const userId = getUserId(req)

      const old = await mcpRepo.findTokenByIdForUser(params.data.id, userId)
      if (!old) throw new AppError('Token not found', 'TOKEN_NOT_FOUND', 404)
      if (old.revokedAt) throw new AppError('Cannot rotate a revoked token', 'TOKEN_REVOKED', 400)

      // Mint the replacement first — same scope, same expiry policy as the
      // original (whether explicit or "never").
      const newValue = generateTokenValue()
      const created = await mcpRepo.createToken({
        userId,
        teamId: old.teamId,
        name: old.name,
        token: newValue,
        scope: old.scope,
        expiresAt: old.expiresAt,
      })

      // Then schedule the old token to expire after the grace window. We
      // intentionally use expires_at (not revoked_at) so a stuck client gets
      // a clean TOKEN_EXPIRED instead of a dead-looking 401.
      const cutoff = new Date(Date.now() + ROTATION_GRACE_HOURS * 60 * 60 * 1000)
      await mcpRepo.scheduleRevocation(old.id, userId, cutoff)

      res.status(201).json({
        id: created.id,
        userId: created.userId,
        teamId: created.teamId,
        name: created.name,
        token: created.token,
        preview: created.token.slice(-4),
        scope: created.scope,
        lastUsedAt: created.lastUsedAt,
        lastUsedIp: created.lastUsedIp,
        expiresAt: created.expiresAt,
        revokedAt: created.revokedAt,
        createdAt: created.createdAt,
        rotatedFromId: old.id,
        oldTokenValidUntil: cutoff.toISOString(),
      })
    } catch (err) {
      next(err)
    }
  })()
})

mcpTokensRouter.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = TokenIdParam.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const userId = getUserId(req)
      await mcpRepo.revokeToken(params.data.id, userId)
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })()
})
