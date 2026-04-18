import { z } from 'zod'

export const CreateTeamSchema = z.object({
  name: z.string().min(1).max(80),
})

export const RenameTeamSchema = z.object({
  name: z.string().min(1).max(80),
})

export const InviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'member']).default('member'),
})

export const ChangeRoleSchema = z.object({
  role: z.enum(['owner', 'member']),
})

export const InviteTokenParamSchema = z.object({
  token: z.string().min(16).max(128),
})

export const TeamIdParamSchema = z.object({
  id: z.string().uuid(),
})

export const TeamMemberParamSchema = z.object({
  id: z.string().uuid(),       // team id
  userId: z.string().uuid(),
})
