import { supabase } from '../db/supabase.client.js'
import { DatabaseError } from '../middleware/error.middleware.js'

export type UsageFeature = 'doc_run' | 'voiceover' | 'try_doc' | 'widget_sessions'

export interface UsageCounter {
  feature: UsageFeature
  count: number
  periodMonth: string
}

function currentPeriodMonth(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
}

export async function incrementUsage(userId: string, feature: UsageFeature, delta = 1): Promise<void> {
  const { error } = await supabase.rpc('increment_usage', {
    p_user_id: userId,
    p_feature: feature,
    p_delta: delta,
  })
  if (error) throw new DatabaseError(error.message)
}

export async function listUsageForCurrentMonth(userId: string): Promise<Record<UsageFeature, number>> {
  const period = currentPeriodMonth()
  const { data, error } = await supabase
    .from('usage_counters')
    .select('feature, count')
    .eq('user_id', userId)
    .eq('period_month', period)
  if (error) throw new DatabaseError(error.message)
  const result: Record<UsageFeature, number> = {
    doc_run: 0,
    voiceover: 0,
    try_doc: 0,
    widget_sessions: 0,
  }
  for (const row of (data as { feature: UsageFeature; count: number }[])) {
    result[row.feature] = row.count
  }
  return result
}

// Register a widget session hit. Returns true if this is a new session for
// the current month (so the caller knows to bump the usage counter).
export async function registerWidgetSession(
  projectId: string,
  ownerUserId: string,
  sessionToken: string,
): Promise<boolean> {
  const period = currentPeriodMonth()

  // Check first — cheaper than relying on an upsert's 'new row' detection
  const { data: existing, error: selectError } = await supabase
    .from('widget_sessions')
    .select('session_token')
    .eq('project_id', projectId)
    .eq('session_token', sessionToken)
    .eq('period_month', period)
    .maybeSingle()
  if (selectError) throw new DatabaseError(selectError.message)

  if (existing) {
    const { error: updateError } = await supabase
      .from('widget_sessions')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .eq('session_token', sessionToken)
      .eq('period_month', period)
    if (updateError) throw new DatabaseError(updateError.message)
    return false
  }

  const { error: insertError } = await supabase.from('widget_sessions').insert({
    project_id: projectId,
    session_token: sessionToken,
    period_month: period,
    user_id: ownerUserId,
  })
  if (insertError) throw new DatabaseError(insertError.message)
  return true
}

// Resolve the project owner from a run id, so services that only have a runId
// can still increment the right user's usage counter.
export async function findOwnerUserIdByRunId(runId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('runs')
    .select('project_id, doc_pages(project_id, projects(user_id))')
    .eq('id', runId)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  if (!data) return null

  // Prefer the denormalized runs.project_id when present
  const projectId = (data as { project_id: string | null }).project_id
  if (projectId) {
    const { data: proj, error: projErr } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle()
    if (projErr) throw new DatabaseError(projErr.message)
    return (proj as { user_id: string } | null)?.user_id ?? null
  }

  // Fallback: via doc_pages join
  const joined = data as unknown as {
    doc_pages: { project_id: string; projects: { user_id: string } | null } | null
  }
  return joined.doc_pages?.projects?.user_id ?? null
}
