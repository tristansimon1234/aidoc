import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import {
  RenameTeamSchema,
  InviteMemberSchema,
  ChangeRoleSchema,
  InviteTokenParamSchema,
  TeamIdParamSchema,
  TeamMemberParamSchema,
} from './team.schema.js'
import * as teamService from './team.service.js'
import { findAuthUserEmail } from '../profile/profile.repository.js'

export const teamRouter = Router()
// Public (no JWT) — the accept page fetches it before login
export const invitePublicRouter = Router()

function getUserId(req: Request): string {
  return (req as Request & { userId: string }).userId
}

// --- /api/teams (authenticated) ---

teamRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const teams = await teamService.listTeams(getUserId(req))
      res.status(200).json(teams)
    } catch (err) { next(err) }
  })()
})

// Team creation is disabled: the single-workspace model gives every user one
// personal team at signup. Collaboration happens by inviting members into
// that workspace, not by spawning extra teams. Kept as a 403 so any stale
// client that still calls it gets a clean, human-readable error.
teamRouter.post('/', (_req: Request, res: Response) => {
  res.status(403).json({
    error: 'Creating additional teams is not available.',
    code: 'TEAM_CREATE_DISABLED',
  })
})

teamRouter.get('/:id', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = TeamIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const result = await teamService.getTeam(params.data.id, getUserId(req))
      res.status(200).json(result)
    } catch (err) { next(err) }
  })()
})

teamRouter.patch('/:id', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = TeamIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = RenameTeamSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())
      const team = await teamService.renameTeam(params.data.id, getUserId(req), body.data.name)
      res.status(200).json(team)
    } catch (err) { next(err) }
  })()
})

teamRouter.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = TeamIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      await teamService.deleteTeam(params.data.id, getUserId(req))
      res.status(204).end()
    } catch (err) { next(err) }
  })()
})

// --- Members ---

teamRouter.get('/:id/members', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = TeamIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const result = await teamService.getTeam(params.data.id, getUserId(req))
      res.status(200).json(result.members)
    } catch (err) { next(err) }
  })()
})

teamRouter.post('/:id/members/invite', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = TeamIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = InviteMemberSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())
      const result = await teamService.inviteMember(
        params.data.id,
        getUserId(req),
        body.data.email,
        body.data.role,
      )
      res.status(201).json({
        inviteId: result.invite.id,
        acceptUrl: result.acceptUrl,
        emailSent: result.emailSent,
      })
    } catch (err) { next(err) }
  })()
})

teamRouter.delete('/:id/members/:userId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = TeamMemberParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      await teamService.removeMember(params.data.id, getUserId(req), params.data.userId)
      res.status(204).end()
    } catch (err) { next(err) }
  })()
})

teamRouter.patch('/:id/members/:userId/role', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = TeamMemberParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = ChangeRoleSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())
      await teamService.changeMemberRole(params.data.id, getUserId(req), params.data.userId, body.data.role)
      res.status(204).end()
    } catch (err) { next(err) }
  })()
})

teamRouter.delete('/:id/invites/:inviteId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const id = req.params.id as string
      const inviteId = req.params.inviteId as string
      if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(inviteId)) {
        throw new ValidationError('Invalid id')
      }
      await teamService.cancelInvite(id, getUserId(req), inviteId)
      res.status(204).end()
    } catch (err) { next(err) }
  })()
})

// --- Invite accept lives on the authed teamRouter, not the public one ---
teamRouter.post('/invites/:token/accept', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = InviteTokenParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const userId = getUserId(req)
      const email = await findAuthUserEmail(userId)
      const result = await teamService.acceptInvite(params.data.token, userId, email)
      res.status(200).json(result)
    } catch (err) { next(err) }
  })()
})

// --- Public peek of an invite: lets the accept page render the team name +
// inviter even before the user has signed in ---
invitePublicRouter.get('/:token', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = InviteTokenParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const invite = await teamService.peekInvite(params.data.token)
      res.status(200).json({
        teamName: invite.teamName,
        email: invite.email,
        inviterName: invite.inviterName,
        expiresAt: invite.expiresAt,
        accepted: invite.acceptedAt !== null,
      })
    } catch (err) { next(err) }
  })()
})
