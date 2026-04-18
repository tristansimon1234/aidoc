export type TeamRole = 'owner' | 'member'

export interface Team {
  id: string
  name: string
  slug: string
  personal: boolean
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export interface TeamMember {
  teamId: string
  userId: string
  email: string | null
  fullName: string | null
  role: TeamRole
  joinedAt: Date
}

export interface TeamInvite {
  id: string
  teamId: string
  email: string
  token: string
  invitedBy: string
  role: TeamRole
  expiresAt: Date
  acceptedAt: Date | null
  createdAt: Date
}

export interface InviteWithTeam {
  id: string
  teamId: string
  teamName: string
  email: string
  role: TeamRole
  inviterName: string | null
  expiresAt: Date
  acceptedAt: Date | null
}

export interface CreateTeamInput {
  name: string
}

export interface InviteMemberInput {
  email: string
  role?: TeamRole
}
