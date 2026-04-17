import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { Plan, PlanId, Subscription, SubscriptionStatus } from './billing.types.js'

interface PlanRow {
  id: string
  name: string
  price_cents: number
  currency: string
  stripe_price_id: string | null
  max_projects: number
  max_doc_runs: number
  max_voiceovers: number
  max_try_doc: number
  max_chat_sessions: number
  sort_order: number
  features: string[] | null
}

function mapToPlan(row: PlanRow): Plan {
  return {
    id: row.id as PlanId,
    name: row.name,
    priceCents: row.price_cents,
    currency: row.currency,
    stripePriceId: row.stripe_price_id,
    maxProjects: row.max_projects,
    maxDocRuns: row.max_doc_runs,
    maxVoiceovers: row.max_voiceovers,
    maxTryDoc: row.max_try_doc,
    maxChatSessions: row.max_chat_sessions,
    sortOrder: row.sort_order,
    features: row.features ?? [],
  }
}

interface SubscriptionRow {
  id: string
  user_id: string
  plan_id: string
  status: string
  current_period_start: string | null
  current_period_end: string | null
  stripe_subscription_id: string | null
  cancel_at_period_end: boolean
  created_at: string
  updated_at: string
}

function mapToSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id as PlanId,
    status: row.status as SubscriptionStatus,
    currentPeriodStart: row.current_period_start ? new Date(row.current_period_start) : null,
    currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end) : null,
    stripeSubscriptionId: row.stripe_subscription_id,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export async function listPlans(): Promise<Plan[]> {
  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .order('sort_order', { ascending: true })
  if (error) throw new DatabaseError(error.message)
  return (data as PlanRow[]).map(mapToPlan)
}

export async function findActiveSubscription(userId: string): Promise<Subscription | null> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'canceled')
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return data ? mapToSubscription(data as SubscriptionRow) : null
}

// Ensure every authenticated user has an active subscription. Acts as a
// safety net in case the auth trigger didn't fire (e.g. legacy users).
export async function ensureFreeSubscription(userId: string): Promise<Subscription> {
  const existing = await findActiveSubscription(userId)
  if (existing) return existing
  const { data, error } = await supabase
    .from('subscriptions')
    .insert({ user_id: userId, plan_id: 'free', status: 'active' })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToSubscription(data as SubscriptionRow)
}

export async function updateActiveSubscriptionPlan(userId: string, planId: PlanId): Promise<Subscription> {
  const active = await ensureFreeSubscription(userId)
  const { data, error } = await supabase
    .from('subscriptions')
    .update({ plan_id: planId, updated_at: new Date().toISOString() })
    .eq('id', active.id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToSubscription(data as SubscriptionRow)
}
