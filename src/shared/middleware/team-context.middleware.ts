import type { Request } from 'express'
import { AppError } from './error.middleware.js'
import { findMember, findPersonalTeamId } from '../../features/team/team.repository.js'

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
    const member = await findMember(headerTeam, userId)
    if (!member) throw new AppError('Not a member of this team', 'FORBIDDEN', 403)
    return headerTeam
  }

  const personal = await findPersonalTeamId(userId)
  if (!personal) {
    throw new AppError('No team context for this user', 'NO_TEAM', 500)
  }
  return personal
}
