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
  // team_members.user_id references auth.users, not profiles, so PostgREST
  // can't resolve a direct join. Do two queries and stitch in JS.
  const { data: memberRows, error } = await supabase
    .from('team_members')
    .select('team_id, user_id, role, joined_at')
    .eq('team_id', teamId)
    .order('joined_at', { ascending: true })
  if (error) throw new DatabaseError(error.message)
  const rows = (memberRows ?? []) as { team_id: string; user_id: string; role: TeamRole; joined_at: string }[]
  if (rows.length === 0) return []

  const userIds = rows.map((r) => r.user_id)
  const { data: profileRows, error: pErr } = await supabase
    .from('profiles')
    .select('id, email, full_name')
    .in('id', userIds)
  if (pErr) throw new DatabaseError(pErr.message)
  const byId = new Map((profileRows ?? []).map((p) => {
    const r = p as { id: string; email: string | null; full_name: string | null }
    return [r.id, r]
  }))

  return rows.map((r) => {
    const prof = byId.get(r.user_id)
    return {
      teamId: r.team_id,
      userId: r.user_id,
      role: r.role,
      email: prof?.email ?? null,
      fullName: prof?.full_name ?? null,
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

/** Members + pending invites — the seat count the plan cap is applied to. */
export async function countTeamSeats(teamId: string): Promise<{ members: number; pendingInvites: number }> {
  const [m, i] = await Promise.all([
    supabase.from('team_members').select('user_id', { count: 'exact', head: true }).eq('team_id', teamId),
    supabase.from('team_invites').select('id', { count: 'exact', head: true }).eq('team_id', teamId).is('accepted_at', null),
  ])
  if (m.error) throw new DatabaseError(m.error.message)
  if (i.error) throw new DatabaseError(i.error.message)
  return { members: m.count ?? 0, pendingInvites: i.count ?? 0 }
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
  // Same caveat as listMembers — no FK from team_invites.invited_by to
  // profiles. Join the team (FK-backed) here, then resolve the inviter's
  // profile in a second query.
  const { data, error } = await supabase
    .from('team_invites')
    .select('id, team_id, email, role, expires_at, accepted_at, invited_by, teams!inner(name)')
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
    invited_by: string
    teams: { name: string } | { name: string }[]
  }
  const team = Array.isArray(r.teams) ? r.teams[0] : r.teams

  let inviterName: string | null = null
  if (r.invited_by) {
    const { data: prof } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', r.invited_by)
      .maybeSingle()
    inviterName = (prof as { full_name: string | null } | null)?.full_name ?? null
  }

  return {
    id: r.id,
    teamId: r.team_id,
    teamName: team?.name ?? 'team',
    email: r.email,
    role: r.role,
    inviterName,
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

export async function listPendingInvites(teamId: string): Promise<{ id: string; email: string; role: TeamRole; createdAt: Date; expiresAt: Date }[]> {
  const { data, error } = await supabase
    .from('team_invites')
    .select('id, email, role, created_at, expires_at')
    .eq('team_id', teamId)
    .is('accepted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw new DatabaseError(error.message)
  return (data ?? []).map((row) => {
    const r = row as { id: string; email: string; role: TeamRole; created_at: string; expires_at: string }
    return {
      id: r.id,
      email: r.email,
      role: r.role,
      createdAt: new Date(r.created_at),
      expiresAt: new Date(r.expires_at),
    }
  })
}

export async function deleteInvite(teamId: string, inviteId: string): Promise<void> {
  const { error } = await supabase
    .from('team_invites')
    .delete()
    .eq('team_id', teamId)
    .eq('id', inviteId)
  if (error) throw new DatabaseError(error.message)
}
