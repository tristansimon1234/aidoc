import { randomBytes } from 'node:crypto'
import { AppError, NotFoundError } from '../../shared/middleware/error.middleware.js'
import { env } from '../../shared/config/env.js'
import { sendEmail } from '../../shared/email/resend.client.js'
import { buildInviteEmail } from '../../shared/email/templates/invite.js'
import * as teamRepo from './team.repository.js'
import { findAuthUserEmail, findProfileById } from '../profile/profile.repository.js'
import type { CreateTeamInput, Team, TeamMember, TeamRole } from './team.types.js'

function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return (base || 'team') + '-' + randomBytes(3).toString('hex')
}

async function requireRole(teamId: string, userId: string, required: TeamRole[] = ['owner']): Promise<TeamRole> {
  const member = await teamRepo.findMember(teamId, userId)
  if (!member) throw new AppError('Not a team member', 'FORBIDDEN', 403)
  if (!required.includes(member.role)) {
    throw new AppError('Only team owners can perform this action', 'FORBIDDEN', 403)
  }
  return member.role
}

export async function listTeams(userId: string): Promise<{ team: Team; role: TeamRole }[]> {
  return teamRepo.findTeamsByUserId(userId)
}

export async function getTeam(teamId: string, userId: string): Promise<{ team: Team; members: TeamMember[]; role: TeamRole; seats: { used: number; max: number; planName: string; allowed: boolean }; pendingInvites: { id: string; email: string; role: TeamRole; createdAt: Date; expiresAt: Date }[] }> {
  const member = await teamRepo.findMember(teamId, userId)
  if (!member) throw new AppError('Not a team member', 'FORBIDDEN', 403)
  const team = await teamRepo.findTeamById(teamId)
  if (!team) throw new NotFoundError('Team')
  const [members, pendingInvites, { checkTeamSeats }] = await Promise.all([
    teamRepo.listMembers(teamId),
    teamRepo.listPendingInvites(teamId),
    import('../billing/billing.service.js'),
  ])
  const seatStatus = await checkTeamSeats(teamId)
  return {
    team,
    members,
    role: member.role,
    seats: {
      used: seatStatus.seatsUsed,
      max: seatStatus.seatsMax,
      planName: seatStatus.planName,
      allowed: seatStatus.allowed,
    },
    pendingInvites,
  }
}

export async function cancelInvite(teamId: string, callerId: string, inviteId: string): Promise<void> {
  await requireRole(teamId, callerId)
  await teamRepo.deleteInvite(teamId, inviteId)
}

export async function createTeam(userId: string, input: CreateTeamInput): Promise<Team> {
  const team = await teamRepo.createTeam({
    name: input.name,
    slug: slugify(input.name),
    createdBy: userId,
  })
  await teamRepo.addMember(team.id, userId, 'owner')
  // Free subscription for the new team (matches what the signup trigger does
  // for personal workspaces). Keeps per-team quota consistent from day one.
  const { ensureFreeSubscription } = await import('../billing/billing.repository.js')
  await ensureFreeSubscription(userId, team.id)
  return team
}

export async function renameTeam(teamId: string, userId: string, name: string): Promise<Team> {
  await requireRole(teamId, userId)
  return teamRepo.renameTeam(teamId, name)
}

export async function deleteTeam(teamId: string, userId: string): Promise<void> {
  await requireRole(teamId, userId)
  const team = await teamRepo.findTeamById(teamId)
  if (!team) throw new NotFoundError('Team')
  if (team.personal) {
    throw new AppError("Can't delete your personal workspace", 'PERSONAL_TEAM', 400)
  }
  await teamRepo.deleteTeam(teamId)
}

export async function removeMember(teamId: string, callerId: string, targetUserId: string): Promise<void> {
  await requireRole(teamId, callerId)
  if (callerId === targetUserId) {
    // Owner leaving: must not be the last owner
    const owners = await teamRepo.countOwners(teamId)
    if (owners <= 1) throw new AppError('You are the last owner — transfer ownership first.', 'LAST_OWNER', 400)
  }
  await teamRepo.removeMember(teamId, targetUserId)
}

export async function changeMemberRole(teamId: string, callerId: string, targetUserId: string, role: TeamRole): Promise<void> {
  await requireRole(teamId, callerId)
  if (role === 'member' && callerId === targetUserId) {
    const owners = await teamRepo.countOwners(teamId)
    if (owners <= 1) throw new AppError('Promote another member before demoting yourself.', 'LAST_OWNER', 400)
  }
  await teamRepo.updateMemberRole(teamId, targetUserId, role)
}

// --- Invites ---

export async function inviteMember(teamId: string, callerId: string, email: string, role: TeamRole = 'member'): Promise<{ invite: Awaited<ReturnType<typeof teamRepo.createInvite>>; acceptUrl: string; emailSent: boolean }> {
  await requireRole(teamId, callerId)
  const team = await teamRepo.findTeamById(teamId)
  if (!team) throw new NotFoundError('Team')

  // Seat cap: refuse if the team is already at the plan's max (members +
  // pending invites combined, so blasting a pile of invites can't bypass).
  const { checkTeamSeats } = await import('../billing/billing.service.js')
  const seats = await checkTeamSeats(teamId)
  if (!seats.allowed) {
    throw new AppError(
      `Your ${seats.planName} plan allows ${seats.seatsMax} seat${seats.seatsMax === 1 ? '' : 's'}. Upgrade to invite more members.`,
      'SEAT_LIMIT',
      402,
    )
  }

  const token = randomToken()
  const invite = await teamRepo.createInvite({
    teamId,
    email: email.toLowerCase(),
    token,
    invitedBy: callerId,
    role,
  })

  const baseUrl = env.PUBLIC_APP_URL ?? ''
  const acceptUrl = `${baseUrl}/invite/${token}`

  // Send the invite email (best-effort: don't fail the invite creation)
  const inviterProfile = await findProfileById(callerId)
  const inviterName = inviterProfile?.fullName
    ?? (await findAuthUserEmail(callerId))
    ?? 'Someone'
  const { subject, html } = buildInviteEmail({
    teamName: team.name,
    inviterName,
    acceptUrl,
  })
  const result = await sendEmail({ to: email, subject, html })

  return { invite, acceptUrl, emailSent: result.sent }
}

export async function acceptInvite(token: string, userId: string, userEmail: string | null): Promise<{ teamId: string }> {
  const invite = await teamRepo.findInviteByToken(token)
  if (!invite) throw new NotFoundError('Invite')
  if (invite.acceptedAt) throw new AppError('Invite already accepted', 'ALREADY_ACCEPTED', 400)
  if (invite.expiresAt.getTime() < Date.now()) throw new AppError('Invite expired', 'EXPIRED', 400)

  // Email must match to prevent token theft — unless the caller has no email
  // resolvable (shouldn't happen post-auth, but don't hard-block).
  if (userEmail && userEmail.toLowerCase() !== invite.email.toLowerCase()) {
    throw new AppError('This invite was sent to a different email', 'EMAIL_MISMATCH', 403)
  }

  await teamRepo.addMember(invite.teamId, userId, invite.role)
  await teamRepo.markInviteAccepted(token)
  return { teamId: invite.teamId }
}

export async function peekInvite(token: string): Promise<NonNullable<Awaited<ReturnType<typeof teamRepo.findInviteByToken>>>> {
  const invite = await teamRepo.findInviteByToken(token)
  if (!invite) throw new NotFoundError('Invite')
  return invite
}
