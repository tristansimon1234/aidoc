import * as billingRepo from '../billing/billing.repository.js'
import * as adminRepo from './admin.repository.js'
import { TOKEN_COSTS } from '../billing/billing.service.js'
import type { UsageFeature } from '../../shared/usage/usage.repository.js'
import type { AdminUsageReport, AdminUsageRow } from './admin.types.js'
import type { PlanId } from '../billing/billing.types.js'

function emptyCounts(): Record<UsageFeature, number> {
  return { doc_run: 0, voiceover: 0, try_doc: 0, chat_sessions: 0 }
}

export async function getUsageReport(periodMonth: string): Promise<AdminUsageReport> {
  const [counters, profiles, subs, plans] = await Promise.all([
    adminRepo.listUsageCountersForMonth(periodMonth),
    adminRepo.listProfiles(),
    adminRepo.listActiveSubscriptions(),
    billingRepo.listPlans(),
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
    }
    const tokensUsed =
      tokensByFeature.doc_run +
      tokensByFeature.voiceover +
      tokensByFeature.try_doc +
      tokensByFeature.chat_sessions
    const percent = plan && plan.monthlyTokens > 0
      ? Math.round((tokensUsed / plan.monthlyTokens) * 1000) / 10
      : 0

    rows.push({
      userId,
      email: profile?.email ?? null,
      fullName: profile?.fullName ?? null,
      planId,
      monthlyTokens: plan?.monthlyTokens ?? null,
      counts,
      tokensByFeature,
      tokensUsed,
      percent,
    })
  }

  // Sort heaviest first so overages pop
  rows.sort((a, b) => b.tokensUsed - a.tokensUsed)

  return { periodMonth, users: rows }
}
