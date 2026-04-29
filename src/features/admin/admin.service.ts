import * as adminRepo from './admin.repository.js'
import * as billingService from '../billing/billing.service.js'
import { TOKEN_COSTS, EURO_COSTS, OVERAGE_EUR, OVERAGE_ENABLED_PLANS } from '../billing/billing.service.js'
import type { UsageFeature } from '../../shared/usage/usage.repository.js'
import type { AdminUsageReport, AdminUsageRow } from './admin.types.js'
import type { PlanId } from '../billing/billing.types.js'

function emptyCounts(): Record<UsageFeature, number> {
  return { doc_run: 0, voiceover: 0, try_doc: 0, chat_sessions: 0, marketing_video: 0 }
}

export async function getUsageReport(periodMonth: string): Promise<AdminUsageReport> {
  const [counters, profiles, subs, plans] = await Promise.all([
    adminRepo.listUsageCountersForMonth(periodMonth),
    adminRepo.listProfiles(),
    adminRepo.listActiveSubscriptions(),
    billingService.listPlans(),
  ])

  const planById = new Map(plans.map((p) => [p.id, p]))
  const subByUser = new Map(subs.map((s) => [s.userId, s.planId as PlanId]))
  const profileByUser = new Map(profiles.map((p) => [p.id, p]))

  const countsByUser = new Map<string, Record<UsageFeature, number>>()
  for (const row of counters) {
    if (!countsByUser.has(row.userId)) countsByUser.set(row.userId, emptyCounts())
    countsByUser.get(row.userId)![row.feature] = row.count
  }

  // Include all known profiles (so admins see users with 0 usage too)
  const allUserIds = new Set<string>()
  for (const p of profiles) allUserIds.add(p.id)
  for (const id of countsByUser.keys()) allUserIds.add(id)

  const rows: AdminUsageRow[] = []
  for (const userId of allUserIds) {
    const profile = profileByUser.get(userId) ?? null
    const planId = subByUser.get(userId) ?? null
    const plan = planId ? planById.get(planId) : undefined
    const counts = countsByUser.get(userId) ?? emptyCounts()
    const tokensByFeature: Record<UsageFeature, number> = {
      doc_run: counts.doc_run * TOKEN_COSTS.doc_run,
      voiceover: counts.voiceover * TOKEN_COSTS.voiceover,
      try_doc: counts.try_doc * TOKEN_COSTS.try_doc,
      chat_sessions: counts.chat_sessions * TOKEN_COSTS.chat_sessions,
      marketing_video: counts.marketing_video * TOKEN_COSTS.marketing_video,
    }
    const tokensUsed =
      tokensByFeature.doc_run +
      tokensByFeature.voiceover +
      tokensByFeature.try_doc +
      tokensByFeature.chat_sessions +
      tokensByFeature.marketing_video
    const euroByFeature: Record<UsageFeature, number> = {
      doc_run: counts.doc_run * EURO_COSTS.doc_run,
      voiceover: counts.voiceover * EURO_COSTS.voiceover,
      try_doc: counts.try_doc * EURO_COSTS.try_doc,
      chat_sessions: counts.chat_sessions * EURO_COSTS.chat_sessions,
      marketing_video: counts.marketing_video * EURO_COSTS.marketing_video,
    }
    const euroCost =
      euroByFeature.doc_run +
      euroByFeature.voiceover +
      euroByFeature.try_doc +
      euroByFeature.chat_sessions +
      euroByFeature.marketing_video
    const percent = plan && plan.monthlyTokens > 0
      ? Math.round((tokensUsed / plan.monthlyTokens) * 1000) / 10
      : 0

    // Overage: only applies to plans that allow it, and only once the user
    // exceeded the monthly token budget. We don't track per-op timestamps,
    // so we proportionally attribute the excess across the month's feature
    // mix and price each slice with OVERAGE_EUR.
    let overageEur = 0
    if (planId && OVERAGE_ENABLED_PLANS.has(planId) && plan && tokensUsed > plan.monthlyTokens && tokensUsed > 0) {
      const excessRatio = (tokensUsed - plan.monthlyTokens) / tokensUsed
      overageEur =
        counts.doc_run * excessRatio * OVERAGE_EUR.doc_run +
        counts.voiceover * excessRatio * OVERAGE_EUR.voiceover +
        counts.try_doc * excessRatio * OVERAGE_EUR.try_doc +
        counts.chat_sessions * excessRatio * OVERAGE_EUR.chat_sessions +
        counts.marketing_video * excessRatio * OVERAGE_EUR.marketing_video
    }

    rows.push({
      userId,
      email: profile?.email ?? null,
      fullName: profile?.fullName ?? null,
      planId,
      monthlyTokens: plan?.monthlyTokens ?? null,
      counts,
      tokensByFeature,
      tokensUsed,
      euroByFeature,
      euroCost,
      overageEur: Math.round(overageEur * 100) / 100,
      percent,
    })
  }

  // Sort heaviest first (by real € cost — what actually matters for ops)
  rows.sort((a, b) => b.euroCost - a.euroCost)

  return { periodMonth, users: rows }
}
