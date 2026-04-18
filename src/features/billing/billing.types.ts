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
  // Single opaque percent of the plan's monthly token budget consumed this
  // month. Raw counts and token weights stay server-side — admins get the
  // breakdown via `/admin/usage`, regular users never see it.
  percent: number
  periodMonth: string  // e.g. '2026-04-01'
  // False when the plan hard-caps (Free / Startup) AND the user has hit 100%.
  // Consumed by the UI to disable expensive buttons (record, upload, generate
  // voiceover, try doc) BEFORE the user starts, so we refuse fast instead of
  // failing mid-upload.
  allowed: boolean
  // Whether the plan lets the user keep going past 100% (Growth / Business).
  // The UI uses this to show a softer "overage in progress" hint instead of
  // a hard block.
  overageEnabled: boolean
}

export interface BillingSummary {
  plan: Plan
  subscription: Subscription
  usage: UsageSnapshot
}
