export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface UserContext {
  name?: string
  email?: string
  plan?: string
  extra?: string
  currentUrl?: string
}

export interface ChatRequest {
  message: string
  history: ChatMessage[]
  userContext?: UserContext
}

export interface DocChunk {
  id: string
  pageId: string
  pageTitle: string
  pageSlug: string
  chunkIndex: number
  chunkText: string
  similarity: number
}

export interface ChatResponse {
  answer: string
  sources: { pageId: string; pageTitle: string; pageSlug: string }[]
  followUps: string[]
  walkthroughAvailable?: boolean
  toolCalls?: { name: string; label: string; args: Record<string, unknown>; result: unknown }[]
}

/**
 * Streaming event shape emitted by chatStream() — mirrors the frontend's
 * ChatStreamEvent in ChatSurface.tsx. Exported here so backend (service)
 * and frontend (UI) share the same contract without circular imports.
 */
export type ChatStreamEvent =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'sources'; items: { pageId: string; pageTitle: string; pageSlug: string }[] }
  | { type: 'followups'; items: string[] }
  | { type: 'walkthrough'; available: boolean }
  | { type: 'tool_start'; id: string; name: string; label: string; args: Record<string, unknown> }
  | { type: 'tool_call'; id: string; name: string; label: string; args: Record<string, unknown>; result: unknown }
  | { type: 'done'; fullText: string }
  | { type: 'error'; message: string }
