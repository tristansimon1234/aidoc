import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import * as billingRepo from './billing.repository.js'
import { listUsageForCurrentMonth } from '../../shared/usage/usage.repository.js'
import type { BillingSummary, Plan, PlanId, UsageSnapshot } from './billing.types.js'

export async function listPlans(): Promise<Plan[]> {
  return billingRepo.listPlans()
}

function currentPeriodMonth(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
}

export async function getSummary(userId: string): Promise<BillingSummary> {
  const [plans, subscription, usage] = await Promise.all([
    billingRepo.listPlans(),
    billingRepo.ensureFreeSubscription(userId),
    listUsageForCurrentMonth(userId),
  ])
  const plan = plans.find((p) => p.id === subscription.planId)
  if (!plan) throw new NotFoundError('Plan')
  const snapshot: UsageSnapshot = {
    docRun: usage.doc_run,
    voiceover: usage.voiceover,
    tryDoc: usage.try_doc,
    chatSessions: usage.chat_sessions,
    periodMonth: currentPeriodMonth(),
  }
  return { plan, subscription, usage: snapshot }
}

// Plan selection. No Stripe yet — mutates the DB directly.
// When Stripe is wired in, this function will redirect paid plans to a
// Checkout Session and only paid webhooks will mutate the subscription;
// the 'free' branch (downgrade) stays as-is.
export async function selectPlan(userId: string, planId: PlanId): Promise<BillingSummary> {
  await billingRepo.updateActiveSubscriptionPlan(userId, planId)
  return getSummary(userId)
}
