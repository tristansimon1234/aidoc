import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { Plan, PlanId, Subscription, SubscriptionStatus } from './billing.types.js'

interface PlanRow {
  id: string
  name: string
  price_cents: number
  currency: string
  stripe_price_id: string | null
  monthly_tokens: number
  sort_order: number
  features: string[] | null
}

function mapToPlan(row: PlanRow, maxMembers: number): Plan {
  return {
    id: row.id as PlanId,
    name: row.name,
    priceCents: row.price_cents,
    currency: row.currency,
    stripePriceId: row.stripe_price_id,
    monthlyTokens: row.monthly_tokens,
    maxMembers,
    sortOrder: row.sort_order,
    features: row.features ?? [],
  }
}

interface SubscriptionRow {
  id: string
  user_id: string
  team_id: string | null
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
    teamId: row.team_id,
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

export async function listPlans(maxMembersByPlan: Record<string, number>): Promise<Plan[]> {
  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .order('sort_order', { ascending: true })
  if (error) throw new DatabaseError(error.message)
  return (data as PlanRow[]).map((row) => mapToPlan(row, maxMembersByPlan[row.id] ?? 1))
}

/** Look up the active subscription for a team (teams are the billing entity
 *  since 20260418000006_add_teams.sql). Defensive order+limit so that even
 *  if a duplicate active row slipped in (e.g. backfill race), we return the
 *  most recent one instead of crashing the whole metered path. */
export async function findActiveSubscriptionByTeam(teamId: string): Promise<Subscription | null> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('team_id', teamId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return data ? mapToSubscription(data as SubscriptionRow) : null
}

/** Ensure the team has an active subscription. Acts as a safety net in case
 *  the signup trigger didn't fire or the team was created before the trigger
 *  extension. `ownerUserId` is written to the user_id audit column. */
export async function ensureFreeSubscription(ownerUserId: string, teamId: string): Promise<Subscription> {
  const existing = await findActiveSubscriptionByTeam(teamId)
  if (existing) return existing
  const { data, error } = await supabase
    .from('subscriptions')
    .insert({ user_id: ownerUserId, team_id: teamId, plan_id: 'free', status: 'active' })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToSubscription(data as SubscriptionRow)
}

export async function updateActiveSubscriptionPlan(ownerUserId: string, teamId: string, planId: PlanId): Promise<Subscription> {
  const active = await ensureFreeSubscription(ownerUserId, teamId)
  const { data, error } = await supabase
    .from('subscriptions')
    .update({ plan_id: planId, updated_at: new Date().toISOString() })
    .eq('id', active.id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToSubscription(data as SubscriptionRow)
}
