import { useCallback, useEffect, useState } from 'react'
import type { ChatMessage } from '../../chat/components/ChatSurface.js'

const STORAGE_PREFIX = 'doclee:chat:'

/**
 * Hook owning the public-docs chat state.
 *
 * - Conversation is persisted in `sessionStorage` keyed by project id, so
 *   it survives a refresh but wipes when the tab closes (no stale week-
 *   old conversations resurfacing). Each project gets its own bucket.
 * - Exposes `pendingMessage` so the sticky bar can hand off "the user
 *   typed this; open the panel and send it" without the panel having to
 *   know about the bar's input.
 *
 * Returns a single source of truth shared by `PublicDocs`, the "Ask AI"
 * button in the topbar, `StickyChatBar`, and `DocsChatPanel`.
 */
export function useDocsChat(projectId: string | undefined): {
  messages: ChatMessage[]
  setMessages: (next: ChatMessage[]) => void
  open: boolean
  openChat: (message?: string) => void
  closeChat: () => void
  pendingMessage: string | null
  consumePendingMessage: () => void
  reset: () => void
} {
  const storageKey = projectId ? `${STORAGE_PREFIX}${projectId}` : null

  const [messages, setMessagesState] = useState<ChatMessage[]>(() => {
    if (!storageKey) return []
    try {
      const raw = sessionStorage.getItem(storageKey)
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      // Drop any half-streamed assistant message that was cut off when
      // the tab was reloaded mid-response — it would otherwise resurrect
      // with `streaming: true` and confuse the surface.
      return (parsed as ChatMessage[]).filter((m) => !m.streaming)
    } catch {
      return []
    }
  })
  const [open, setOpen] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)

  // Mirror to sessionStorage on every change. Swallow QuotaExceeded —
  // worst case the next refresh starts fresh, which is fine.
  useEffect(() => {
    if (!storageKey) return
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(messages))
    } catch {
      /* quota / private mode — non-fatal */
    }
  }, [messages, storageKey])

  const setMessages = useCallback((next: ChatMessage[]) => {
    setMessagesState(next)
  }, [])

  const openChat = useCallback((message?: string) => {
    setOpen(true)
    if (message && message.trim()) setPendingMessage(message)
  }, [])

  const closeChat = useCallback(() => {
    setOpen(false)
  }, [])

  const consumePendingMessage = useCallback(() => {
    setPendingMessage(null)
  }, [])

  const reset = useCallback(() => {
    setMessagesState([])
    setPendingMessage(null)
    if (storageKey) {
      try { sessionStorage.removeItem(storageKey) } catch { /* non-fatal */ }
    }
  }, [storageKey])

  return { messages, setMessages, open, openChat, closeChat, pendingMessage, consumePendingMessage, reset }
}
