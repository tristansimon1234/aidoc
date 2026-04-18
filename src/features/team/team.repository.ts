import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { Team, TeamMember, TeamInvite, TeamRole, InviteWithTeam } from './team.types.js'

interface TeamRow {
  id: string
  name: string
  slug: string
  personal: boolean
  created_by: string
  created_at: string
  updated_at: string
}

function mapTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    personal: row.personal,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export async function findTeamsByUserId(userId: string): Promise<{ team: Team; role: TeamRole }[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('role, teams!inner(*)')
    .eq('user_id', userId)
    .order('joined_at', { ascending: true })
  if (error) throw new DatabaseError(error.message)
  return (data ?? []).map((row) => {
    const team = (row as unknown as { teams: TeamRow }).teams
    return { team: mapTeam(team), role: (row as unknown as { role: TeamRole }).role }
  })
}

export async function findTeamById(teamId: string): Promise<Team | null> {
  const { data, error } = await supabase.from('teams').select('*').eq('id', teamId).single()
  if (error && error.code === 'PGRST116') return null
  if (error) throw new DatabaseError(error.message)
  return data ? mapTeam(data as TeamRow) : null
}

export async function findMember(teamId: string, userId: string): Promise<{ role: TeamRole } | null> {
  const { data, error } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return data ? { role: (data as { role: TeamRole }).role } : null
}

export async function listMembers(teamId: string): Promise<TeamMember[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('team_id, user_id, role, joined_at, profiles!inner(email, full_name)')
    .eq('team_id', teamId)
    .order('joined_at', { ascending: true })
  if (error) throw new DatabaseError(error.message)
  return (data ?? []).map((row) => {
    const r = row as unknown as {
      team_id: string
      user_id: string
      role: TeamRole
      joined_at: string
      profiles: { email: string | null; full_name: string | null } | { email: string | null; full_name: string | null }[]
    }
    const profile = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles
    return {
      teamId: r.team_id,
      userId: r.user_id,
      role: r.role,
      email: profile?.email ?? null,
      fullName: profile?.full_name ?? null,
      joinedAt: new Date(r.joined_at),
    }
  })
}

export async function createTeam(input: { name: string; slug: string; createdBy: string }): Promise<Team> {
  const { data, error } = await supabase
    .from('teams')
    .insert({ name: input.name, slug: input.slug, personal: false, created_by: input.createdBy })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapTeam(data as TeamRow)
}

export async function renameTeam(teamId: string, name: string): Promise<Team> {
  const { data, error } = await supabase
    .from('teams')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', teamId)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapTeam(data as TeamRow)
}

export async function addMember(teamId: string, userId: string, role: TeamRole): Promise<void> {
  const { error } = await supabase
    .from('team_members')
    .insert({ team_id: teamId, user_id: userId, role })
  if (error && !error.message.includes('duplicate')) throw new DatabaseError(error.message)
}

export async function removeMember(teamId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('team_members')
    .delete()
    .eq('team_id', teamId)
    .eq('user_id', userId)
  if (error) throw new DatabaseError(error.message)
}

export async function updateMemberRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
  const { error } = await supabase
    .from('team_members')
    .update({ role })
    .eq('team_id', teamId)
    .eq('user_id', userId)
  if (error) throw new DatabaseError(error.message)
}

export async function countOwners(teamId: string): Promise<number> {
  const { count, error } = await supabase
    .from('team_members')
    .select('user_id', { count: 'exact', head: true })
    .eq('team_id', teamId)
    .eq('role', 'owner')
  if (error) throw new DatabaseError(error.message)
  return count ?? 0
}

export async function deleteTeam(teamId: string): Promise<void> {
  const { error } = await supabase.from('teams').delete().eq('id', teamId)
  if (error) throw new DatabaseError(error.message)
}

// --- Invites ---

interface InviteRow {
  id: string
  team_id: string
  email: string
  token: string
  invited_by: string
  role: TeamRole
  expires_at: string
  accepted_at: string | null
  created_at: string
}

function mapInvite(row: InviteRow): TeamInvite {
  return {
    id: row.id,
    teamId: row.team_id,
    email: row.email,
    token: row.token,
    invitedBy: row.invited_by,
    role: row.role,
    expiresAt: new Date(row.expires_at),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at) : null,
    createdAt: new Date(row.created_at),
  }
}

export async function createInvite(input: {
  teamId: string
  email: string
  token: string
  invitedBy: string
  role: TeamRole
}): Promise<TeamInvite> {
  // Upsert on (team_id, email) so re-inviting rotates the token
  const { data, error } = await supabase
    .from('team_invites')
    .upsert(
      {
        team_id: input.teamId,
        email: input.email.toLowerCase(),
        token: input.token,
        invited_by: input.invitedBy,
        role: input.role,
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        accepted_at: null,
      },
      { onConflict: 'team_id,email' },
    )
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapInvite(data as InviteRow)
}

export async function findInviteByToken(token: string): Promise<InviteWithTeam | null> {
  const { data, error } = await supabase
    .from('team_invites')
    .select('id, team_id, email, role, expires_at, accepted_at, invited_by, teams!inner(name), profiles!team_invites_invited_by_fkey(full_name)')
    .eq('token', token)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  if (!data) return null
  const r = data as unknown as {
    id: string
    team_id: string
    email: string
    role: TeamRole
    expires_at: string
    accepted_at: string | null
    teams: { name: string } | { name: string }[]
    profiles: { full_name: string | null } | { full_name: string | null }[] | null
  }
  const team = Array.isArray(r.teams) ? r.teams[0] : r.teams
  const profile = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles
  return {
    id: r.id,
    teamId: r.team_id,
    teamName: team?.name ?? 'team',
    email: r.email,
    role: r.role,
    inviterName: profile?.full_name ?? null,
    expiresAt: new Date(r.expires_at),
    acceptedAt: r.accepted_at ? new Date(r.accepted_at) : null,
  }
}

export async function markInviteAccepted(token: string): Promise<void> {
  const { error } = await supabase
    .from('team_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('token', token)
  if (error) throw new DatabaseError(error.message)
}
