// Returns a stable per-tab, per-project session token used for billing dedup.
// Lives in sessionStorage: one token for the duration of a browser tab.
// Mirrors what the public widget does, so the in-app ChatPanel counts
// towards the same `chat_sessions` quota.
export function getChatSessionToken(projectId: string): string {
  const key = `aidoc_chat_sid_${projectId}`
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const fresh =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? (crypto as Crypto & { randomUUID: () => string }).randomUUID()
        : `sid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    sessionStorage.setItem(key, fresh)
    return fresh
  } catch {
    return `sid_${Date.now()}`
  }
}
