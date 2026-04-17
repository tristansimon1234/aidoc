export type PlanId = 'free' | 'startup' | 'growth' | 'business'

export interface Plan {
  id: PlanId
  name: string
  priceCents: number
  currency: string
  stripePriceId: string | null
  monthlyTokens: number
  sortOrder: number
  features: string[]
}

export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing'

export interface Subscription {
  id: string
  userId: string
  planId: PlanId
  status: SubscriptionStatus
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  stripeSubscriptionId: string | null
  cancelAtPeriodEnd: boolean
  createdAt: Date
  updatedAt: Date
}

export interface UsageSnapshot {
  // Each value is a percent of the plan's monthly token budget consumed by
  // that feature. Sum of breakdown ≈ percent (rounding aside). Exposing only
  // percents — never raw counts or token weights — so we can tune internals
  // without renegotiating with users.
  percent: number
  breakdown: {
    docRun: number
    voiceover: number
    tryDoc: number
    chatSessions: number
  }
  periodMonth: string  // e.g. '2026-04-01'
}

export interface BillingSummary {
  plan: Plan
  subscription: Subscription
  usage: UsageSnapshot
}
