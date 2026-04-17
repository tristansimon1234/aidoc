import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'

export interface UsageCounterRow {
  userId: string
  feature: 'doc_run' | 'voiceover' | 'try_doc' | 'chat_sessions'
  count: number
}

export interface ProfileRow {
  id: string
  email: string | null
  fullName: string | null
}

export interface SubscriptionRow {
  userId: string
  planId: string
}

export async function listUsageCountersForMonth(periodMonth: string): Promise<UsageCounterRow[]> {
  const { data, error } = await supabase
    .from('usage_counters')
    .select('user_id, feature, count')
    .eq('period_month', periodMonth)
  if (error) throw new DatabaseError(error.message)
  return (data as { user_id: string; feature: string; count: number }[]).map((r) => ({
    userId: r.user_id,
    feature: r.feature as UsageCounterRow['feature'],
    count: r.count,
  }))
}

export async function listProfiles(): Promise<ProfileRow[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name')
  if (error) throw new DatabaseError(error.message)
  return (data as { id: string; email: string | null; full_name: string | null }[]).map((r) => ({
    id: r.id,
    email: r.email,
    fullName: r.full_name,
  }))
}

export async function listActiveSubscriptions(): Promise<SubscriptionRow[]> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('user_id, plan_id')
    .neq('status', 'canceled')
  if (error) throw new DatabaseError(error.message)
  return (data as { user_id: string; plan_id: string }[]).map((r) => ({
    userId: r.user_id,
    planId: r.plan_id,
  }))
}
