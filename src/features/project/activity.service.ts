import { findProjectById } from './project.repository.js'
import { NotFoundError, AppError } from '../../shared/middleware/error.middleware.js'
import { findMember } from '../team/team.repository.js'
import * as activityRepo from './activity.repository.js'
import type { ActivityItem } from './activity.types.js'

const MAX_ITEMS = 20
const PER_SOURCE = 20

/**
 * Aggregate the last ~20 interesting events for a project across the three
 * sources (page edits, doc generations, new members). Enriches user ids to
 * display names via a single batch profile lookup, then merges + sorts
 * desc by timestamp.
 *
 * Auth: requires the caller to be a member of the project's team (route
 * enforces). Returns plain display-ready strings — no sensitive fields
 * leak from the raw rows.
 */
export async function getProjectActivity(projectId: string, callerUserId: string): Promise<ActivityItem[]> {
  const project = await findProjectById(projectId)
  if (!project) throw new NotFoundError('Project')
  const member = await findMember(project.teamId, callerUserId)
  if (!member) throw new AppError('Not a team member', 'FORBIDDEN', 403)

  const [edits, gens, joins] = await Promise.all([
    activityRepo.listRecentPageEdits(projectId, PER_SOURCE),
    activityRepo.listRecentDocGenerations(projectId, PER_SOURCE),
    activityRepo.listRecentMemberJoins(project.teamId, PER_SOURCE),
  ])

  // Resolve every user id we care about in one profile lookup. Cheaper
  // than N+1 per activity row.
  const userIds = new Set<string>()
  edits.forEach((e) => { if (e.lastEditedBy) userIds.add(e.lastEditedBy) })
  gens.forEach((g) => { if (g.triggeredByUserId) userIds.add(g.triggeredByUserId) })
  joins.forEach((j) => userIds.add(j.userId))
  const names = await batchResolveUserNames(Array.from(userIds))

  const items: ActivityItem[] = []
  for (const e of edits) {
    items.push({
      kind: 'page_edited',
      at: e.lastEditedAt,
      actorName: e.lastEditedBy ? (names.get(e.lastEditedBy) ?? null) : null,
      subject: e.title,
      href: `/projects/${e.projectId}/pages/${e.pageId}`,
    })
  }
  for (const g of gens) {
    items.push({
      kind: 'doc_generated',
      at: g.completedAt,
      actorName: g.triggeredByUserId ? (names.get(g.triggeredByUserId) ?? null) : null,
      subject: g.pageTitle,
      href: `/projects/${g.projectId}/pages/${g.pageId}`,
    })
  }
  for (const j of joins) {
    items.push({
      kind: 'member_joined',
      at: j.joinedAt,
      actorName: names.get(j.userId) ?? null,
      subject: j.role === 'owner' ? 'Workspace created' : 'Joined the team',
    })
  }

  return items
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, MAX_ITEMS)
}

async function batchResolveUserNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map()
  const { supabase } = await import('../../shared/db/supabase.client.js')
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name')
    .in('id', userIds)
  if (error) return new Map()
  const map = new Map<string, string>()
  for (const row of data ?? []) {
    const r = row as { id: string; email: string | null; full_name: string | null }
    const name = r.full_name ?? r.email ?? null
    if (name) map.set(r.id, name)
  }
  return map
}
