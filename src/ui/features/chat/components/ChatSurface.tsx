import { useState, useRef, useEffect, useCallback } from 'react'
import { Spinner, MarkdownRenderer } from '../../../design-system/components/index.js'
import type { ChatResponseDTO } from '../../../shared/api/client.js'
import { VideoUploadBlock } from '../../project/components/VideoUploadBlock.js'
import styles from './ChatSurface.module.css'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: { pageId: string; pageTitle: string; pageSlug: string }[]
  followUps?: string[]
  walkthroughAvailable?: boolean
  /** True while the assistant message is being streamed in. The UI shows
   *  a blinking caret at the end of the text and suppresses follow-ups
   *  until the stream completes. */
  streaming?: boolean
  /** Whether the user clicked "watch walkthrough" — expands the inline
   *  narrated player only when they opt in, not automatically. */
  videoExpanded?: boolean
  /** Tool calls the assistant executed during this turn — rendered as
   *  compact action cards above the answer text. `status: 'pending'`
   *  means the tool is mid-execution; `'done'` means we have the result.
   *  `id` matches tool_start with its tool_call so the UI can swap state. */
  toolCalls?: { id?: string; name: string; label: string; args: Record<string, unknown>; result: unknown; status?: 'pending' | 'done' }[]
}

/** Streaming event shape emitted by sendStream — mirrors the backend's
 *  ChatStreamEvent in chat.service.ts. The surface ignores any event it
 *  doesn't recognise so future additions don't break older clients. */
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

/**
 * Shape of the chat API the surface depends on. Admin uses the authed
 * `api.chat.*` helpers; public docs use an anonymous fetch-based adapter.
 * Both implement the same contract so the surface stays pure.
 */
export interface ChatSurfaceApi {
  /** Optional indexing trigger — returns how many chunks were indexed.
   *  When omitted, the surface skips the indexing step entirely. */
  index?: (projectId: string) => Promise<{ indexed: number }>
  /** Return whether the project has embeddings indexed. When omitted,
   *  the surface assumes yes and shows chat immediately. */
  status?: (projectId: string) => Promise<{ hasEmbeddings: boolean }>
  /** Legacy single-shot send — kept as a fallback when sendStream is
   *  unavailable (older clients, MCP, tests). */
  send: (
    projectId: string,
    message: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    sessionToken?: string,
  ) => Promise<ChatResponseDTO>
  /** Streaming send. When provided, the surface uses this instead of
   *  `send` and renders deltas as they arrive. The async generator must
   *  yield ChatStreamEvent in the order the backend emits them. */
  sendStream?: (
    projectId: string,
    message: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    sessionToken?: string,
    signal?: AbortSignal,
  ) => AsyncIterable<ChatStreamEvent>
  suggestions: (projectId: string) => Promise<{ suggestions: string[] }>
}

export interface SourceMedia {
  videoUrl?: string | null
  audioUrl?: string | null
}

interface ChatSurfaceProps {
  projectId: string
  projectName: string
  api: ChatSurfaceApi
  /** Called when a source tag is clicked — caller decides how to route. Optional `tab` deep-links to a specific tab. */
  onSourceClick: (source: { pageId: string; pageTitle: string; pageSlug: string; tab?: string }) => void
  /** Per-session token for anonymous usage analytics / dedup. */
  sessionToken?: string
  fallbackSuggestions?: string[]
  /** If the first cited source has a narrated video, render it inline
   *  under the answer. Called per assistant message; return undefined
   *  or null when no media is available for that source. */
  resolveSourceMedia?: (source: { pageId: string; pageSlug: string }) => SourceMedia | null | undefined
  /** Controlled messages array. When provided together with
   *  `onMessagesChange`, the surface defers conversation state to the
   *  parent — used by the public docs side panel to persist the
   *  conversation in sessionStorage across page navigation. When
   *  omitted, the surface keeps its own internal state (admin uses). */
  messages?: ChatMessage[]
  onMessagesChange?: (next: ChatMessage[]) => void
  /** Visual variant. `fullpage` (default) is the standalone chat view.
   *  `sidepanel` strips the welcome header padding so it fits the
   *  narrower right-side panel on public docs. */
  variant?: 'fullpage' | 'sidepanel'
  /** When set to a non-empty string, the surface auto-sends it on next
   *  render and calls `onPendingMessageConsumed`. Used to forward a
   *  message typed in the sticky bar into the panel. */
  pendingMessage?: string | null
  onPendingMessageConsumed?: () => void
  /** Optional video file pre-claimed by the next prepare_doc_generation
   *  tool call — lets a drop on the chat bar feed straight into the
   *  upload block without the user having to pick it again. */
  pendingVideo?: File | null
  onPendingVideoConsumed?: () => void
  /** Fired once per resolved mutating tool call (create_page, update_page,
   *  prepare_doc_generation, publish_page). The host uses this to refetch
   *  the page tree so the sidebar/nav reflect the AI's actions. */
  onProjectMutation?: (info: { tool: string; pageId?: string; pageSlug?: string; pageTitle?: string; previousContent?: string | null }) => void
  /** Fired when a `navigate_to_page` tool resolves — used by the host
   *  to auto-route the user to the destination page (chat-first UX). */
  onAutoNavigate?: (info: { pageId: string; pageTitle: string; pageSlug: string }) => void
}

const DEFAULT_SUGGESTIONS = [
  'How does this product work?',
  'What are the main features?',
  'Walk me through the setup process',
]

/** Extract every doc-page slug Gemini cited via a resolved absolute
 *  markdown link (https://…/docs/<projectId>/<slug>). Slugs ordered
 *  by first appearance. */
function extractCitedSlugs(markdown: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /\[[^\]]+\]\(https?:\/\/[^)]+\/docs\/[^/]+\/([^)?#]+)[^)]*\)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const slug = m[1]
    if (slug && !seen.has(slug)) {
      seen.add(slug)
      out.push(slug)
    }
  }
  return out
}

/**
 * Compact narrated video player for chat responses — same voice-over
 * semantics as PublicDocs.NarratedVideo: video forced muted so the
 * original track never plays over the ElevenLabs narration, volume
 * slider piped to the audio element.
 */
function ChatNarratedVideo({ videoUrl, audioUrl }: { videoUrl: string; audioUrl?: string }): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const syncAudio = (): void => {
    const v = videoRef.current
    const a = audioRef.current
    if (!v || !a) return
    if (Math.abs(v.currentTime - a.currentTime) > 0.3) a.currentTime = v.currentTime
  }
  const handlePlay = (): void => {
    const a = audioRef.current
    const v = videoRef.current
    if (a && v) { a.currentTime = v.currentTime; void a.play() }
  }
  const handlePause = (): void => { audioRef.current?.pause() }
  const handleVolumeChange = (): void => {
    const v = videoRef.current
    const a = audioRef.current
    if (!v || !audioUrl) return
    if (!v.muted) v.muted = true
    if (a) a.volume = v.volume
  }

  return (
    <div className={styles.narratedVideo}>
      <video
        ref={videoRef}
        src={videoUrl}
        controls
        preload="metadata"
        muted={Boolean(audioUrl)}
        onPlay={handlePlay}
        onPause={handlePause}
        onSeeked={syncAudio}
        onTimeUpdate={syncAudio}
        onVolumeChange={handleVolumeChange}
      />
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" />}
    </div>
  )
}

// --- Tool call rendering ---

interface ToolCallResult {
  id?: string
  pageId?: string
  title?: string
  pageTitle?: string
  slug?: string
  pageSlug?: string
  status?: string
  hasContent?: boolean
  count?: number
  isPublic?: boolean
  [key: string]: unknown
}

function extractResultCount(result: unknown): number {
  if (Array.isArray(result)) return result.length
  if (typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>
    if (typeof r.count === 'number') return r.count
  }
  return 0
}

function extractResultTitle(result: unknown): string | null {
  if (typeof result === 'object' && result !== null) {
    const r = result as ToolCallResult
    if (typeof r.title === 'string') return r.title
    if (typeof r.pageTitle === 'string') return r.pageTitle
  }
  return null
}

/** Compact card shown above assistant text for each tool call the AI executed. */
function ToolCallCard({
  toolCall,
  onSourceClick,
}: {
  toolCall: { name: string; label: string; args: Record<string, unknown>; result: unknown; status?: 'pending' | 'done' }
  onSourceClick: (source: { pageId: string; pageTitle: string; pageSlug: string; tab?: string }) => void
}): React.ReactElement {
  const { name, label, args, result, status } = toolCall
  const isPending = status === 'pending'

  const pageTitle = extractResultTitle(result)
  const count = extractResultCount(result)

  const handlePageClick = (tab?: string): void => {
    if (typeof result === 'object' && result !== null) {
      const r = result as ToolCallResult
      const id = typeof r.id === 'string' ? r.id : (typeof r.pageId === 'string' ? r.pageId : null)
      const slug = typeof r.slug === 'string' ? r.slug : (typeof r.pageSlug === 'string' ? r.pageSlug : null)
      if (id && slug) {
        onSourceClick({ pageId: id, pageTitle: pageTitle ?? '', pageSlug: slug, tab })
      }
    }
  }

  return (
    <div className={`${styles.toolCallCard} ${isPending ? styles.toolCallPending : ''}`}>
      <span className={styles.toolCallIcon} aria-hidden="true">
        {isPending ? (
          <span className={styles.toolCallSpinner} />
        ) : (
          <>
        {name === 'create_page' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" /><path d="M5 12h14" />
          </svg>
        )}
        {name === 'update_page' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          </svg>
        )}
        {name === 'list_pages' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" />
          </svg>
        )}
        {name === 'search_docs' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
        )}
        {name === 'prepare_doc_generation' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        )}
        {name === 'navigate_to_page' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
          </svg>
        )}
        {name === 'generate_voiceover' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" />
          </svg>
        )}
        {name === 'run_try_doc' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        {name === 'publish_page' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 11l18-9-9 18-2-8z" />
          </svg>
        )}
        {name === 'generate_marketing_video' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="20" height="15" rx="2" ry="2" /><polyline points="17 2 12 7 7 2" />
          </svg>
        )}
          </>
        )}
      </span>
      <span className={styles.toolCallLabel}>
        {isPending ? `${label}…` : label}
      </span>
      {!isPending && name === 'create_page' && pageTitle && (
        <button className={styles.toolCallAction} onClick={() => handlePageClick()}>
          {pageTitle} →
        </button>
      )}
      {!isPending && name === 'update_page' && pageTitle && (
        <span className={styles.toolCallMeta}>{pageTitle}</span>
      )}
      {!isPending && name === 'list_pages' && count > 0 && (
        <span className={styles.toolCallMeta}>{count} page{count !== 1 ? 's' : ''}</span>
      )}
      {!isPending && name === 'search_docs' && (
        <span className={styles.toolCallMeta}>
          {typeof args.query === 'string' ? `"${args.query}"` : ''}
          {count > 0 ? ` · ${count} result${count !== 1 ? 's' : ''}` : ''}
        </span>
      )}
      {!isPending && name === 'navigate_to_page' && pageTitle && (
        <button className={styles.toolCallAction} onClick={() => handlePageClick()}>
          {pageTitle} →
        </button>
      )}
      {!isPending && name === 'generate_voiceover' && pageTitle && (
        <button className={styles.toolCallAction} onClick={() => handlePageClick()}>
          {pageTitle} · open Walkthrough →
        </button>
      )}
      {!isPending && name === 'run_try_doc' && pageTitle && (
        <button className={styles.toolCallAction} onClick={() => handlePageClick()}>
          {pageTitle} · open Test →
        </button>
      )}
      {!isPending && name === 'publish_page' && pageTitle && (
        <span className={styles.toolCallMeta}>
          {pageTitle} {(result as { isPublic?: boolean })?.isPublic ? '· published' : '· unpublished'}
        </span>
      )}
      {!isPending && name === 'generate_marketing_video' && pageTitle && (
        <button className={styles.toolCallAction} onClick={() => handlePageClick('marketing')}>
          {pageTitle} · open Marketing →
        </button>
      )}
    </div>
  )
}

/**
 * Smart auto-scroll: follows the bottom while content streams in, but
 * pauses tracking the moment the user scrolls up. Same pattern as
 * Claude.ai / ChatGPT — the user can re-read earlier text without the
 * UI yanking them back to the bottom. Resumes following when the user
 * scrolls back to within 80px of the bottom.
 */
function useAutoScroll(deps: unknown[]): {
  scrollerRef: React.RefObject<HTMLDivElement>
  endRef: React.RefObject<HTMLDivElement>
} {
  const scrollerRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>
  const endRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>
  const followingRef = useRef(true)

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = (): void => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      followingRef.current = distFromBottom < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (followingRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { scrollerRef, endRef }
}

/**
 * Polished chat UI surface — Vercel AI / Claude.ai style. Streams
 * tokens with a blinking caret, slide-in messages, smart auto-scroll,
 * source pills that fade in after the stream completes.
 */
export function ChatSurface({
  projectId,
  projectName,
  api,
  onSourceClick,
  sessionToken,
  fallbackSuggestions = DEFAULT_SUGGESTIONS,
  resolveSourceMedia,
  messages: controlledMessages,
  onMessagesChange,
  variant = 'fullpage',
  pendingMessage,
  onPendingMessageConsumed,
  pendingVideo,
  onPendingVideoConsumed,
  onProjectMutation,
  onAutoNavigate,
}: ChatSurfaceProps): React.ReactElement {
  // When a video is pre-claimed by a drop on the chat bar, this state
  // tracks which tool-call id has claimed the file. The matching
  // VideoUploadBlock receives the file as `preselectedFile`.
  const [claimedVideoFile, setClaimedVideoFile] = useState<File | null>(null)
  const [claimedVideoTcId, setClaimedVideoTcId] = useState<string | null>(null)
  // Controlled vs. uncontrolled: when the parent passes a messages array
  // AND a change handler, the surface defers state to the parent (used
  // by the public docs side panel for sessionStorage persistence).
  // Otherwise we keep an internal useState so existing admin callers
  // continue to work without any changes.
  const [internalMessages, setInternalMessages] = useState<ChatMessage[]>([])
  const isControlled = controlledMessages !== undefined && typeof onMessagesChange === 'function'
  const messages = isControlled ? controlledMessages : internalMessages
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const setMessages = useCallback((value: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])): void => {
    if (isControlled) {
      const next = typeof value === 'function' ? value(messagesRef.current) : value
      onMessagesChange!(next)
    } else {
      setInternalMessages(value)
    }
  }, [isControlled, onMessagesChange])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [indexing, setIndexing] = useState(Boolean(api.index || api.status))
  const [indexed, setIndexed] = useState<boolean | null>(api.index || api.status ? null : true)
  const [indexError, setIndexError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>(fallbackSuggestions)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Forward ref to sendMessage so the pending-message effect can call it
  // without depending on the (later-declared) memoized callback.
  const sendMessageRef = useRef<((text: string) => Promise<void>) | null>(null)

  const { scrollerRef, endRef } = useAutoScroll([messages.length, messages[messages.length - 1]?.content])

  useEffect(() => {
    void checkAndIndex()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => {
    if (indexed && !sending) inputRef.current?.focus()
  }, [indexed, sending])

  // Cancel any in-flight stream when unmounting so the SSE connection
  // closes cleanly instead of leaking.
  useEffect(() => () => abortRef.current?.abort(), [])

  // Fire `onProjectMutation` and `onAutoNavigate` callbacks exactly once
  // per resolved tool call. We track consumed ids in a ref so re-renders
  // don't double-fire.
  const consumedToolCallIds = useRef<Set<string>>(new Set())
  const MUTATING_TOOLS = ['create_page', 'update_page', 'publish_page', 'prepare_doc_generation', 'generate_voiceover']
  useEffect(() => {
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.toolCalls) continue
      for (const tc of m.toolCalls) {
        if (!tc.id || tc.status !== 'done') continue
        if (consumedToolCallIds.current.has(tc.id)) continue
        const r = (tc.result ?? {}) as Record<string, unknown>
        if (r.error) {
          consumedToolCallIds.current.add(tc.id)
          continue
        }
        if (tc.name === 'navigate_to_page' && onAutoNavigate) {
          const pageId = typeof r.pageId === 'string' ? r.pageId : null
          const pageSlug = typeof r.pageSlug === 'string' ? r.pageSlug : null
          const pageTitle = typeof r.pageTitle === 'string' ? r.pageTitle : ''
          if (pageId && pageSlug) {
            consumedToolCallIds.current.add(tc.id)
            onAutoNavigate({ pageId, pageTitle, pageSlug })
            continue
          }
        }
        if (MUTATING_TOOLS.includes(tc.name) && onProjectMutation) {
          consumedToolCallIds.current.add(tc.id)
          const pageId = typeof r.pageId === 'string' ? r.pageId : (typeof r.id === 'string' ? r.id : undefined)
          const pageSlug = typeof r.pageSlug === 'string' ? r.pageSlug : (typeof r.slug === 'string' ? r.slug : undefined)
          const pageTitle = typeof r.pageTitle === 'string' ? r.pageTitle : (typeof r.title === 'string' ? r.title : undefined)
          const previousContent = typeof r.previousContent === 'string' ? r.previousContent : null
          onProjectMutation({ tool: tc.name, pageId, pageSlug, pageTitle, previousContent })
        }
      }
    }
  }, [messages, onProjectMutation, onAutoNavigate])

  // Claim a pending video drop for the most recent `prepare_doc_generation`
  // tool-call that has a resolved result and no file claimed yet. Done in
  // an effect (not at render time) so we don't fire side effects during
  // rendering and so re-entry from React 18 strict-mode is safe.
  useEffect(() => {
    if (!pendingVideo) return
    if (claimedVideoFile) return
    // Walk messages newest-first to find the first matching tool call
    for (let mi = messages.length - 1; mi >= 0; mi--) {
      const m = messages[mi]
      if (!m || m.role !== 'assistant' || !m.toolCalls) continue
      for (let ti = m.toolCalls.length - 1; ti >= 0; ti--) {
        const tc = m.toolCalls[ti]
        if (tc?.name === 'prepare_doc_generation' && tc.status !== 'pending' && tc.id) {
          setClaimedVideoFile(pendingVideo)
          setClaimedVideoTcId(tc.id)
          onPendingVideoConsumed?.()
          return
        }
      }
    }
  }, [messages, pendingVideo, claimedVideoFile, onPendingVideoConsumed])

  // When the parent hands us a pending message (e.g. user typed in the
  // sticky bar then opened the panel), auto-send it once the chat is
  // ready. Consume the value immediately so a re-render doesn't fire it
  // twice — the parent clears its side via onPendingMessageConsumed.
  const pendingSentRef = useRef<string | null>(null)
  useEffect(() => {
    if (!pendingMessage) return
    if (indexing || indexed === false) return
    if (pendingSentRef.current === pendingMessage) return
    pendingSentRef.current = pendingMessage
    void sendMessageRef.current?.(pendingMessage)
    onPendingMessageConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMessage, indexing, indexed])

  const checkAndIndex = async (): Promise<void> => {
    if (!api.status && !api.index) {
      setIndexed(true)
      setIndexing(false)
      void loadSuggestions()
      return
    }
    try {
      setIndexing(true)
      const hasEmbeddings = api.status
        ? (await api.status(projectId)).hasEmbeddings
        : false
      if (hasEmbeddings) {
        setIndexed(true)
        setIndexing(false)
        void loadSuggestions()
        return
      }
      if (api.index) {
        const result = await api.index(projectId)
        const ready = result.indexed > 0
        setIndexed(ready)
        if (ready) void loadSuggestions()
      } else {
        setIndexed(false)
      }
    } catch (err) {
      setIndexError((err as Error).message)
      setIndexed(false)
    } finally {
      setIndexing(false)
    }
  }

  const loadSuggestions = async (): Promise<void> => {
    try {
      const r = await api.suggestions(projectId)
      if (r.suggestions.length > 0) setSuggestions(r.suggestions)
    } catch { /* fallback suggestions stay */ }
  }

  /** Patch the most recent assistant message in `messages`. Used while
   *  streaming so each delta updates the same message instead of
   *  appending a new one. */
  const patchLastAssistant = useCallback((patch: Partial<ChatMessage> | ((m: ChatMessage) => ChatMessage)): void => {
    setMessages((prev) => {
      // Find the last assistant message
      let idx = -1
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i]?.role === 'assistant') { idx = i; break }
      }
      if (idx === -1) return prev
      const next = [...prev]
      const current = next[idx]!
      next[idx] = typeof patch === 'function' ? patch(current) : { ...current, ...patch }
      return next
    })
  }, [])

  const sendMessage = useCallback(async (text: string): Promise<void> => {
    const msg = text.trim()
    if (!msg || sending) return

    setInput('')
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: msg },
      // Pre-create the assistant message in `streaming` state so the UI
      // shows the thinking dots / caret immediately, before the first
      // delta arrives.
      { role: 'assistant', content: '', streaming: true },
    ])
    setSending(true)

    const history = messages.map((m) => ({ role: m.role, content: m.content }))

    try {
      if (api.sendStream) {
        // Streaming path
        const controller = new AbortController()
        abortRef.current = controller
        let fullText = ''
        for await (const event of api.sendStream(projectId, msg, history, sessionToken, controller.signal)) {
          if (event.type === 'delta') {
            fullText += event.text
            patchLastAssistant({ content: fullText })
          } else if (event.type === 'sources') {
            patchLastAssistant({ sources: event.items })
          } else if (event.type === 'followups') {
            patchLastAssistant({ followUps: event.items })
          } else if (event.type === 'walkthrough') {
            patchLastAssistant({ walkthroughAvailable: event.available })
          } else if (event.type === 'tool_start') {
            // Push a pending tool call so the UI shows "calling…" immediately
            patchLastAssistant((m) => ({
              ...m,
              toolCalls: [
                ...(m.toolCalls ?? []),
                { id: event.id, name: event.name, label: event.label, args: event.args, result: null, status: 'pending' },
              ],
            }))
          } else if (event.type === 'tool_call') {
            // Replace the matching pending entry with the resolved result
            patchLastAssistant((m) => {
              const existing = m.toolCalls ?? []
              const idx = existing.findIndex((t) => t.id === event.id)
              const resolved = { id: event.id, name: event.name, label: event.label, args: event.args, result: event.result, status: 'done' as const }
              const next = idx >= 0
                ? existing.map((t, i) => (i === idx ? resolved : t))
                : [...existing, resolved]
              return { ...m, toolCalls: next }
            })
          } else if (event.type === 'done') {
            // Replace with the post-processed full text (link rewriting,
            // image URL normalization). May be identical to fullText for
            // well-formed Gemini output.
            patchLastAssistant({ content: event.fullText, streaming: false })
          } else if (event.type === 'error') {
            patchLastAssistant({ content: 'Sorry, something went wrong. Please try again.', streaming: false })
          }
        }
        // Stream finished without explicit done — close streaming state
        patchLastAssistant({ streaming: false })
        abortRef.current = null
      } else {
        // Legacy single-shot path
        const response = await api.send(projectId, msg, history, sessionToken)
        patchLastAssistant({
          content: response.answer,
          sources: response.sources,
          followUps: response.followUps,
          walkthroughAvailable: response.walkthroughAvailable,
          streaming: false,
        })
      }
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError'
      patchLastAssistant({
        content: isAbort ? '' : 'Sorry, something went wrong. Please try again.',
        streaming: false,
      })
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }, [messages, sending, projectId, api, sessionToken, patchLastAssistant])

  // Keep the ref in sync so the pending-message effect always calls the
  // latest version. Avoids capturing a stale closure.
  sendMessageRef.current = sendMessage

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage(input)
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
  }

  const rootClass = `${styles.page} ${variant === 'sidepanel' ? styles.pageSidePanel : ''}`

  if (indexing) {
    return (
      <div className={rootClass}>
        <div className={styles.centerState}>
          <Spinner size="sm" />
          <span className={styles.stateText}>Loading chat…</span>
        </div>
      </div>
    )
  }

  if (indexed === false) {
    return (
      <div className={rootClass}>
        <div className={styles.centerState}>
          <div className={styles.stateIcon}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2C6.477 2 2 6.015 2 10.97c0 2.735 1.329 5.175 3.406 6.813.118.093.2.236.2.394L5.4 20.6a.85.85 0 0 0 1.254.745l2.663-1.472a.85.85 0 0 1 .562-.088c.7.14 1.426.215 2.171.215 5.523 0 10-4.015 10-8.97C22 6.015 17.523 2 12 2z" />
            </svg>
          </div>
          <span className={styles.stateTitle}>{indexError ? 'Indexing failed' : 'No documentation yet'}</span>
          <span className={styles.stateText}>
            {indexError
              ? `Something went wrong: ${indexError}`
              : 'Generate documentation for your pages first, then come back to chat with it.'}
          </span>
          {indexError && (
            <button className={styles.retryBtn} onClick={() => { setIndexError(null); void checkAndIndex() }}>
              Retry indexing
            </button>
          )}
        </div>
      </div>
    )
  }

  // The last assistant message — we render its follow-ups separately so
  // they appear under the bubble after streaming ends.
  const lastAssistant = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.role === 'assistant') return m
    }
    return null
  })()

  return (
    <div className={rootClass}>
      <div className={styles.chat}>
        <div className={styles.messages} ref={scrollerRef}>
          {messages.length === 0 ? (
            <div className={styles.welcome}>
              <h2 className={styles.welcomeTitle}>Chat with {projectName}</h2>
              <p className={styles.welcomeHint}>
                Ask anything about the documentation.
              </p>
              <div className={styles.suggestionsGrid}>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    className={styles.suggestion}
                    onClick={() => void sendMessage(s)}
                    disabled={sending}
                  >
                    {s}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={styles.suggestionIcon}>
                      <path d="M7 17 17 7" /><path d="M7 7h10v10" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`${styles.msgRow} ${msg.role === 'user' ? styles.msgRowUser : styles.msgRowAssistant}`}
                >
                  {msg.role === 'user' ? (
                    <div className={styles.bubbleUser}>{msg.content}</div>
                  ) : (
                    <div className={styles.bubbleAssistant}>
                      {/* Tool call action cards — rendered above the answer text.
                       *  prepare_doc_generation gets an inline video upload block;
                       *  all other tools get the compact action card. */}
                      {msg.toolCalls && msg.toolCalls.length > 0 && (
                        <div className={styles.toolCallList}>
                          {msg.toolCalls.map((tc, tcIdx) => {
                            if (tc.name === 'prepare_doc_generation' && tc.status !== 'pending') {
                              const r = tc.result as { pageId?: string; pageTitle?: string; pageSlug?: string } | null
                              if (r?.pageId && r.pageSlug) {
                                const claimedFile = tc.id && tc.id === claimedVideoTcId ? claimedVideoFile : null
                                return (
                                  <VideoUploadBlock
                                    key={tc.id ?? tcIdx}
                                    projectId={projectId}
                                    pageId={r.pageId}
                                    pageTitle={r.pageTitle ?? tc.args.pageTitle as string ?? 'Documentation'}
                                    pageSlug={r.pageSlug}
                                    preselectedFile={claimedFile}
                                  />
                                )
                              }
                            }
                            return <ToolCallCard key={tc.id ?? tcIdx} toolCall={tc} onSourceClick={onSourceClick} />
                          })}
                        </div>
                      )}
                      {/* Empty + streaming = shimmer "Thinking…" with brain icon
                       *  (Claude / Vercel AI pattern). The text gradient sweeps
                       *  across the letters while we wait for the first delta. */}
                      {msg.content === '' && msg.streaming ? (
                        <div className={styles.thinking} aria-label="Thinking">
                          {/* Lucide "brain" — anatomical two-hemisphere
                           *  outline. The earlier sparkle felt generic;
                           *  the brain reads as "the AI is thinking"
                           *  more clearly. */}
                          <svg className={styles.thinkingIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
                            <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
                            <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
                            <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
                            <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
                            <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
                            <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
                            <path d="M6 18a4 4 0 0 1-1.967-.516" />
                            <path d="M19.967 17.484A4 4 0 0 1 18 18" />
                          </svg>
                          <span className={styles.thinkingText}>Thinking…</span>
                        </div>
                      ) : (
                        <div className={`${styles.assistantText} ${msg.streaming ? styles.assistantStreaming : ''}`}>
                          <MarkdownRenderer content={msg.content} />
                        </div>
                      )}

                      {/* Suggested narrated walkthrough (when the answer cites a page that has one) */}
                      {!msg.streaming && resolveSourceMedia && msg.content && (() => {
                        const citedSlugs = extractCitedSlugs(msg.content)
                        if (citedSlugs.length === 0) return null
                        let match: { title: string; videoUrl: string; audioUrl?: string | null } | null = null
                        for (const slug of citedSlugs) {
                          const source = msg.sources?.find((s) => s.pageSlug === slug)
                          const media = resolveSourceMedia(source ?? { pageId: '', pageSlug: slug })
                          if (media?.videoUrl) {
                            match = {
                              title: source?.pageTitle ?? slug,
                              videoUrl: media.videoUrl,
                              audioUrl: media.audioUrl,
                            }
                            break
                          }
                        }
                        if (!match) return null
                        const expand = (): void => {
                          setMessages((prev) => prev.map((m, idx) => idx === i ? { ...m, videoExpanded: true } : m))
                        }
                        return (
                          <div className={styles.sourceVideo}>
                            {msg.videoExpanded ? (
                              <>
                                <ChatNarratedVideo
                                  videoUrl={match.videoUrl}
                                  audioUrl={match.audioUrl ?? undefined}
                                />
                                <p className={styles.sourceVideoHint}>
                                  Clip from <strong>{match.title}</strong>
                                </p>
                              </>
                            ) : (
                              <button className={styles.videoButton} onClick={expand}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                  <polygon points="6 3 20 12 6 21 6 3" />
                                </svg>
                                Watch the <strong>{match.title}</strong> walkthrough
                              </button>
                            )}
                          </div>
                        )
                      })()}

                      {!msg.streaming && msg.sources && msg.sources.length > 0 && (
                        <div className={styles.sources}>
                          {msg.sources.map((s) => (
                            <button
                              key={s.pageSlug}
                              className={styles.sourceTag}
                              onClick={() => onSourceClick(s)}
                            >
                              {s.pageTitle}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* Follow-ups under the last assistant message, only after streaming completes */}
              {lastAssistant && !lastAssistant.streaming && lastAssistant.followUps && lastAssistant.followUps.length > 0 && (
                <div className={styles.followUps}>
                  {lastAssistant.followUps.map((q) => (
                    <button key={q} className={styles.followUp} onClick={() => void sendMessage(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <div ref={endRef} />
        </div>

        <div className={styles.inputBar}>
          <div className={styles.inputWrapper}>
            <textarea
              ref={inputRef}
              className={styles.input}
              placeholder="Ask anything…"
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              disabled={sending}
              rows={1}
            />
            <button
              className={styles.sendBtn}
              onClick={() => void sendMessage(input)}
              disabled={!input.trim() || sending}
              aria-label="Send"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
