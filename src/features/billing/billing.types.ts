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
  // Only a single percent exposed — internals (per-feature counts, weighting)
  // stay server-side so we can tune without renegotiating with users.
  percent: number
  periodMonth: string  // e.g. '2026-04-01'
}

export interface BillingSummary {
  plan: Plan
  subscription: Subscription
  usage: UsageSnapshot
}
