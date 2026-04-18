import type { Request } from 'express'
import { AppError } from './error.middleware.js'
import { supabase } from '../db/supabase.client.js'
import { DatabaseError } from './error.middleware.js'

/**
 * Resolve the team the authenticated request is operating on.
 *
 * Reads `X-Team-Id` from the request headers. If absent, falls back to the
 * user's personal team (every signup creates one). Verifies the caller is
 * actually a member — rejects with 403 otherwise.
 *
 * Use in routes that are team-scoped (billing summary, team settings, etc.).
 * Routes that are project-scoped don't need this — they resolve the team
 * from the project's `team_id` column instead.
 */
export async function resolveActiveTeam(req: Request, userId: string): Promise<string> {
  const headerTeam = req.header('x-team-id')
  if (headerTeam && /^[0-9a-f-]{36}$/i.test(headerTeam)) {
    const member = await checkMembership(headerTeam, userId)
    if (!member) throw new AppError('Not a member of this team', 'FORBIDDEN', 403)
    return headerTeam
  }

  const personal = await findPersonalTeam(userId)
  if (!personal) {
    throw new AppError('No team context for this user', 'NO_TEAM', 500)
  }
  return personal
}

async function checkMembership(teamId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return Boolean(data)
}

async function findPersonalTeam(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('teams')
    .select('id')
    .eq('created_by', userId)
    .eq('personal', true)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return (data as { id: string } | null)?.id ?? null
}
