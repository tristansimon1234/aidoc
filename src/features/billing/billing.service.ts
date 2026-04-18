import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import * as billingRepo from './billing.repository.js'
import { listUsageForCurrentMonth } from '../../shared/usage/usage.repository.js'
import type { BillingSummary, Plan, PlanId, UsageSnapshot } from './billing.types.js'

export async function listPlans(): Promise<Plan[]> {
  return billingRepo.listPlans()
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
// profit. Only applied on plans in `OVERAGE_ENABLED_PLANS` — Free / Startup
// hit a hard wall instead, which is intentional (drives upgrades).
export const OVERAGE_EUR = {
  doc_run: 0.15,
  voiceover: 0.45,
  try_doc: 0.60,
  chat_sessions: 0.03,
} as const

export const OVERAGE_ENABLED_PLANS: ReadonlySet<PlanId> = new Set(['growth', 'business'])

function currentPeriodMonth(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
}

function pctOf(tokens: number, budget: number): number {
  if (budget <= 0) return 0
  return Math.round((tokens / budget) * 1000) / 10  // one decimal
}

export async function getSummary(userId: string): Promise<BillingSummary> {
  const [plans, subscription, counters] = await Promise.all([
    billingRepo.listPlans(),
    billingRepo.ensureFreeSubscription(userId),
    listUsageForCurrentMonth(userId),
  ])
  const plan = plans.find((p) => p.id === subscription.planId)
  if (!plan) throw new NotFoundError('Plan')

  const tokensUsed =
    counters.doc_run * TOKEN_COSTS.doc_run +
    counters.voiceover * TOKEN_COSTS.voiceover +
    counters.try_doc * TOKEN_COSTS.try_doc +
    counters.chat_sessions * TOKEN_COSTS.chat_sessions

  const snapshot: UsageSnapshot = {
    percent: pctOf(tokensUsed, plan.monthlyTokens),
    periodMonth: currentPeriodMonth(),
  }
  return { plan, subscription, usage: snapshot }
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
 * (Free / Startup) has hit 100% of its monthly token budget. Overage-enabled
 * plans (Growth / Business) always pass through; they'll be billed the overage
 * via `OVERAGE_EUR` when Stripe is wired.
 */
export async function checkQuota(userId: string): Promise<QuotaCheck> {
  const [plans, subscription, counters] = await Promise.all([
    billingRepo.listPlans(),
    billingRepo.ensureFreeSubscription(userId),
    listUsageForCurrentMonth(userId),
  ])
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

// Plan selection. No Stripe yet — mutates the DB directly.
// When Stripe is wired in, this function will redirect paid plans to a
// Checkout Session and only paid webhooks will mutate the subscription;
// the 'free' branch (downgrade) stays as-is.
export async function selectPlan(userId: string, planId: PlanId): Promise<BillingSummary> {
  await billingRepo.updateActiveSubscriptionPlan(userId, planId)
  return getSummary(userId)
}
