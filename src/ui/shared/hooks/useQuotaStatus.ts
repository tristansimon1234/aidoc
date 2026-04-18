import { useAsync } from './useAsync.js'
import { api, type BillingSummaryDTO } from '../api/client.js'

export interface QuotaStatus {
  loading: boolean
  allowed: boolean
  percent: number
  overageEnabled: boolean
  planName: string | null
}

/**
 * Pre-flight quota check used by UI before starting an expensive op
 * (record, upload, generate voiceover, try doc, chat). Disables the button
 * AND shows an inline banner when the user's plan hard-caps and they're at
 * 100% — lets us refuse at the click, not mid-upload.
 *
 * Backed by the same `/api/billing/summary` the billing tab uses, so we
 * don't add a second roundtrip.
 */
export function useQuotaStatus(): QuotaStatus {
  const { data, loading } = useAsync<BillingSummaryDTO>(() => api.billing.summary())
  if (!data) {
    // Optimistic default while loading — don't block the UI on billing latency.
    return { loading, allowed: true, percent: 0, overageEnabled: false, planName: null }
  }
  return {
    loading,
    allowed: data.usage.allowed,
    percent: data.usage.percent,
    overageEnabled: data.usage.overageEnabled,
    planName: data.plan.name,
  }
}
