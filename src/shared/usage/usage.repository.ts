import { supabase } from '../db/supabase.client.js'
import { DatabaseError } from '../middleware/error.middleware.js'

export type UsageFeature = 'doc_run' | 'voiceover' | 'try_doc' | 'chat_sessions'
export type ChatSessionSource = 'widget' | 'app'

function currentPeriodMonth(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
}

/** Bump the team's monthly counter for a given feature. The RPC is
 *  SECURITY DEFINER, takes the team_id, and derives the audit user_id
 *  from the team's primary owner. */
export async function incrementUsage(teamId: string, feature: UsageFeature, delta = 1): Promise<void> {
  const { error } = await supabase.rpc('increment_usage', {
    p_team_id: teamId,
    p_feature: feature,
    p_delta: delta,
  })
  if (error) throw new DatabaseError(error.message)
}

export async function listUsageForCurrentMonth(teamId: string): Promise<Record<UsageFeature, number>> {
  const period = currentPeriodMonth()
  const { data, error } = await supabase
    .from('usage_counters')
    .select('feature, count')
    .eq('team_id', teamId)
    .eq('period_month', period)
  if (error) throw new DatabaseError(error.message)
  const result: Record<UsageFeature, number> = {
    doc_run: 0,
    voiceover: 0,
    try_doc: 0,
    chat_sessions: 0,
  }
  for (const row of (data as { feature: UsageFeature; count: number }[])) {
    result[row.feature] = row.count
  }
  return result
}

// Register a chat session hit. Returns true if this is a NEW session for the
// current month — the caller bumps the team's chat_sessions counter only on
// new-session inserts, so the billing unit is the session regardless of how
// many messages the visitor sends.
//
// Atomicity: the PK (project_id, session_token, period_month) is the single
// race-free anchor. We `insert(..., { ignoreDuplicates: true })` first — the
// row either inserts or the PK rejects it — then UPDATE last_seen_at when it
// was a duplicate. Previous implementation did a SELECT-then-INSERT-or-UPDATE
// which let two concurrent callers (same session, two tabs) each read "no
// row" and double-count the session before the second INSERT hit the PK.
export async function registerChatSession(
  projectId: string,
  teamId: string,
  sessionToken: string,
  source: ChatSessionSource,
): Promise<boolean> {
  const period = currentPeriodMonth()
  const nowIso = new Date().toISOString()
  const ownerUserId = await findOwnerUserIdByTeamId(teamId)

  // Attempt the insert. On PK conflict the duplicate is silently dropped
  // (ignoreDuplicates: true), returning an empty array. The SELECT on the
  // inserted row tells us whether WE inserted vs someone else did first.
  const { data: inserted, error: insertError } = await supabase
    .from('chat_sessions')
    .insert({
      project_id: projectId,
      session_token: sessionToken,
      period_month: period,
      user_id: ownerUserId ?? teamId,
      source,
      started_at: nowIso,
      last_seen_at: nowIso,
    })
    .select('project_id')

  if (insertError) {
    // Duplicate-key on the PK is expected when the row already exists; any
    // other error is a real problem.
    const msg = insertError.message.toLowerCase()
    if (!msg.includes('duplicate') && insertError.code !== '23505') {
      throw new DatabaseError(insertError.message)
    }
  }

  const isNewSession = (inserted?.length ?? 0) > 0
  if (isNewSession) return true

  // Existing row — just bump last_seen_at. Failure here is non-fatal for
  // billing (we already know it's not a new session), but still surface it.
  const { error: updateError } = await supabase
    .from('chat_sessions')
    .update({ last_seen_at: nowIso })
    .eq('project_id', projectId)
    .eq('session_token', sessionToken)
    .eq('period_month', period)
  if (updateError) throw new DatabaseError(updateError.message)
  return false
}

export async function findOwnerUserIdByTeamId(teamId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('team_members')
    .select('user_id')
    .eq('team_id', teamId)
    .eq('role', 'owner')
    .order('joined_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return (data as { user_id: string } | null)?.user_id ?? null
}

/** Resolve the team from a run id — used by billing / analytics / chat log */
export async function findTeamIdByRunId(runId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('runs')
    .select('project_id')
    .eq('id', runId)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  const projectId = (data as { project_id: string | null } | null)?.project_id
  if (!projectId) return null
  return findTeamIdByProjectId(projectId)
}

/** Resolve the team that owns a project. Used by every route that needs to
 *  bump usage / enforce quota / log analytics on a team's account. */
export async function findTeamIdByProjectId(projectId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('team_id')
    .eq('id', projectId)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return (data as { team_id: string } | null)?.team_id ?? null
}

/** @deprecated — use findTeamIdByProjectId; kept temporarily so old call
 *  sites compile while we migrate them. Returns the team's primary owner. */
export async function findOwnerUserIdByProjectId(projectId: string): Promise<string | null> {
  const teamId = await findTeamIdByProjectId(projectId)
  if (!teamId) return null
  return findOwnerUserIdByTeamId(teamId)
}

/** @deprecated — use findTeamIdByRunId. */
export async function findOwnerUserIdByRunId(runId: string): Promise<string | null> {
  const teamId = await findTeamIdByRunId(runId)
  if (!teamId) return null
  return findOwnerUserIdByTeamId(teamId)
}
