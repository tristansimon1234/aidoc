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

      const tokenValue = `aidoc_usr_${randomBytes(32).toString('hex')}`
      const created = await mcpRepo.createToken({
        userId,
        teamId: parsed.data.teamId,
        name: parsed.data.name,
        token: tokenValue,
      })

      // Return the full token ONCE — this is the only moment it's visible.
      res.status(201).json({
        id: created.id,
        userId: created.userId,
        teamId: created.teamId,
        name: created.name,
        token: created.token,
        preview: created.token.slice(-4),
        lastUsedAt: created.lastUsedAt,
        revokedAt: created.revokedAt,
        createdAt: created.createdAt,
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
