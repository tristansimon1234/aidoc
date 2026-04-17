import type { PlanId } from '../billing/billing.types.js'
import type { UsageFeature } from '../../shared/usage/usage.repository.js'

export interface AdminUsageRow {
  userId: string
  email: string | null
  fullName: string | null
  planId: PlanId | null
  monthlyTokens: number | null
  // Raw per-feature counts (admin-only, never shown to regular users)
  counts: Record<UsageFeature, number>
  // Derived: weighted tokens spent on each feature + total
  tokensByFeature: Record<UsageFeature, number>
  tokensUsed: number
  // Real AI / infra cost in EUR, per feature + total — the actual COGS
  euroByFeature: Record<UsageFeature, number>
  euroCost: number
  // 0-∞; can exceed 100 if the user went over quota
  percent: number
}

export interface AdminUsageReport {
  periodMonth: string
  users: AdminUsageRow[]
}
