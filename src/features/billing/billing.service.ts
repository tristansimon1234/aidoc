import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import * as billingRepo from './billing.repository.js'
import { findTeamById } from '../team/team.repository.js'
import { listUsageForCurrentMonth } from '../../shared/usage/usage.repository.js'
import type { BillingSummary, Plan, PlanId, UsageSnapshot } from './billing.types.js'

export async function listPlans(): Promise<Plan[]> {
  return billingRepo.listPlans(MAX_TEAM_MEMBERS)
}

// Token cost of each metered operation. Kept in code (not DB) so we can
// adjust pricing internally without a migration or user-facing change.
// Units are abstract "tokens" — how the user-facing quota is expressed.
// Exported for the admin feature which needs to compute weighted spend per user.
export const TOKEN_COSTS = {
  doc_run: 100,
  voiceover: 300,
  try_doc: 400,
  chat_sessions: 20,
} as const

// Real AI / infra cost per operation in EUR — the actual COGS we pay to
// Gemini / ElevenLabs / Browserbase / Claude on each call. Used by the admin
// dashboard and later by the overage billing logic. Keep in sync with reality.
export const EURO_COSTS = {
  doc_run: 0.10,       // Gemini 2.5 Flash video + doc + storage
  voiceover: 0.30,     // ElevenLabs eleven_multilingual_v2 ~0.20€/1K chars × ~1.5K chars
  try_doc: 0.40,       // Claude Sonnet 4 (via Stagehand) + Browserbase + Gemini analysis
  chat_sessions: 0.02, // Gemini 2.5 Flash ~6 turns per session
} as const

// Overage price per extra op, billed once the user exceeds their plan's
// monthly budget. Set at ~1.5× COGS so the marginal op still turns a healthy
// profit. Only applied on plans in `OVERAGE_ENABLED_PLANS` — Free / Founder
// hit a hard wall instead, which is intentional (drives upgrades).
export const OVERAGE_EUR = {
  doc_run: 0.15,
  voiceover: 0.45,
  try_doc: 0.60,
  chat_sessions: 0.03,
} as const

export const OVERAGE_ENABLED_PLANS: ReadonlySet<PlanId> = new Set(['team', 'agency'])

// Maximum total team size (owner + members) per plan. Pending invites count
// toward the cap to prevent "blast a pile of invites, bypass check at accept".
// Free = owner-only (can't invite); paid tiers scale up. Tunable in code.
export const MAX_TEAM_MEMBERS: Record<PlanId, number> = {
  free: 1,
  founder: 3,      // owner + 2 (a solo founder occasionally brings in a collab)
  team: 10,        // owner + 9 (product/support squad)
  agency: 25,      // owner + 24 (docs-touching folks inside an agency)
} as const

function currentPeriodMonth(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
}

function pctOf(tokens: number, budget: number): number {
  if (budget <= 0) return 0
  return Math.round((tokens / budget) * 1000) / 10  // one decimal
}

export async function getSummary(ownerUserId: string, teamId: string): Promise<BillingSummary> {
  const [plans, subscription, counters, team] = await Promise.all([
    billingRepo.listPlans(MAX_TEAM_MEMBERS),
    billingRepo.ensureFreeSubscription(ownerUserId, teamId),
    listUsageForCurrentMonth(teamId),
    findTeamById(teamId),
  ])
  const plan = plans.find((p) => p.id === subscription.planId)
  if (!plan) throw new NotFoundError('Plan')
  if (!team) throw new NotFoundError('Team')

  const tokensUsed =
    counters.doc_run * TOKEN_COSTS.doc_run +
    counters.voiceover * TOKEN_COSTS.voiceover +
    counters.try_doc * TOKEN_COSTS.try_doc +
    counters.chat_sessions * TOKEN_COSTS.chat_sessions

  const overageEnabled = OVERAGE_ENABLED_PLANS.has(plan.id)
  const snapshot: UsageSnapshot = {
    percent: pctOf(tokensUsed, plan.monthlyTokens),
    periodMonth: currentPeriodMonth(),
    allowed: overageEnabled || tokensUsed < plan.monthlyTokens,
    overageEnabled,
  }
  return {
    plan,
    subscription,
    usage: snapshot,
    team: { id: team.id, name: team.name, personal: team.personal },
  }
}

export interface QuotaCheck {
  allowed: boolean
  percent: number
  planId: PlanId
  monthlyTokens: number
  tokensUsed: number
  overageEnabled: boolean
}

/**
 * Pre-flight quota check — call before any metered operation (chat, doc gen,
 * voiceover, try doc). Returns `allowed: false` when a hard-cap plan
 * (Free / Founder) has hit 100% of its monthly token budget. Overage-enabled
 * plans (Team / Agency) always pass through; they'll be billed the overage
 * via `OVERAGE_EUR` when Stripe is wired.
 *
 * Accepts a teamId since subscriptions are team-scoped post-teams migration.
 */
export async function checkQuota(teamId: string): Promise<QuotaCheck> {
  const [plans, subscription, counters] = await Promise.all([
    billingRepo.listPlans(MAX_TEAM_MEMBERS),
    billingRepo.findActiveSubscriptionByTeam(teamId),
    listUsageForCurrentMonth(teamId),
  ])

  // Every team should have an active subscription (created by the signup
  // trigger or createTeam). If not, treat as blocked to be safe.
  if (!subscription) {
    return { allowed: false, percent: 100, planId: 'free', monthlyTokens: 0, tokensUsed: 0, overageEnabled: false }
  }

  const plan = plans.find((p) => p.id === subscription.planId)
  if (!plan) throw new NotFoundError('Plan')

  const tokensUsed =
    counters.doc_run * TOKEN_COSTS.doc_run +
    counters.voiceover * TOKEN_COSTS.voiceover +
    counters.try_doc * TOKEN_COSTS.try_doc +
    counters.chat_sessions * TOKEN_COSTS.chat_sessions

  const percent = pctOf(tokensUsed, plan.monthlyTokens)
  const overageEnabled = OVERAGE_ENABLED_PLANS.has(plan.id)
  const allowed = overageEnabled || tokensUsed < plan.monthlyTokens

  return {
    allowed,
    percent,
    planId: plan.id,
    monthlyTokens: plan.monthlyTokens,
    tokensUsed,
    overageEnabled,
  }
}

export interface SeatStatus {
  planId: PlanId
  planName: string
  seatsUsed: number      // active members + pending invites
  seatsMax: number
  allowed: boolean       // false when seatsUsed >= seatsMax
}

/**
 * How many seats this team has consumed vs its plan's cap. The seat count is
 * `active members + pending invites` so an owner can't blast 100 invites on
 * a 5-seat plan and bypass the cap at acceptance time.
 */
export async function checkTeamSeats(teamId: string): Promise<SeatStatus> {
  const [plans, subscription, seats] = await Promise.all([
    billingRepo.listPlans(MAX_TEAM_MEMBERS),
    billingRepo.findActiveSubscriptionByTeam(teamId),
    (await import('../team/team.repository.js')).countTeamSeats(teamId),
  ])
  const planId: PlanId = subscription?.planId ?? 'free'
  const plan = plans.find((p) => p.id === planId)
  const seatsUsed = seats.members + seats.pendingInvites
  const seatsMax = MAX_TEAM_MEMBERS[planId]
  return {
    planId,
    planName: plan?.name ?? planId,
    seatsUsed,
    seatsMax,
    allowed: seatsUsed < seatsMax,
  }
}

// Plan selection. No Stripe yet — mutates the DB directly.
// When Stripe is wired in, this function will redirect paid plans to a
// Checkout Session and only paid webhooks will mutate the subscription;
// the 'free' branch (downgrade) stays as-is.
export async function selectPlan(ownerUserId: string, teamId: string, planId: PlanId): Promise<BillingSummary> {
  await billingRepo.updateActiveSubscriptionPlan(ownerUserId, teamId, planId)
  return getSummary(ownerUserId, teamId)
}
