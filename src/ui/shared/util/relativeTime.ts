/**
 * Compact English relative time: "just now", "3m ago", "2h ago", "4d ago",
 * "3w ago", "Jan 4". Used in page headers and activity feeds. Accepts
 * ISO strings or Date instances; returns '' on invalid input so callers can
 * safely render without a null guard.
 */
export function formatRelativeTime(input: string | Date | null | undefined): string {
  if (!input) return ''
  const date = input instanceof Date ? input : new Date(input)
  const ms = Date.now() - date.getTime()
  if (Number.isNaN(ms)) return ''
  if (ms < 0) return 'just now'

  const sec = Math.floor(ms / 1000)
  if (sec < 45) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  const wk = Math.floor(day / 7)
  if (wk < 5) return `${wk}w ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
