import { useState, useRef, useEffect, useCallback } from 'react'
import { Spinner, MarkdownRenderer } from '../../../design-system/components/index.js'
import type { ChatResponseDTO } from '../../../shared/api/client.js'
import styles from './ChatSurface.module.css'

interface ChatMessage {
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
  /** Called when a source tag is clicked — caller decides how to route. */
  onSourceClick: (source: { pageId: string; pageTitle: string; pageSlug: string }) => void
  /** Per-session token for anonymous usage analytics / dedup. */
  sessionToken?: string
  fallbackSuggestions?: string[]
  /** If the first cited source has a narrated video, render it inline
   *  under the answer. Called per assistant message; return undefined
   *  or null when no media is available for that source. */
  resolveSourceMedia?: (source: { pageId: string; pageSlug: string }) => SourceMedia | null | undefined
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
}: ChatSurfaceProps): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [indexing, setIndexing] = useState(Boolean(api.index || api.status))
  const [indexed, setIndexed] = useState<boolean | null>(api.index || api.status ? null : true)
  const [indexError, setIndexError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>(fallbackSuggestions)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

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

  if (indexing) {
    return (
      <div className={styles.page}>
        <div className={styles.centerState}>
          <Spinner size="sm" />
          <span className={styles.stateText}>Loading chat…</span>
        </div>
      </div>
    )
  }

  if (indexed === false) {
    return (
      <div className={styles.page}>
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
    <div className={styles.page}>
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
                      {/* Empty + streaming = shimmer "Thinking…" with brain icon
                       *  (Claude / Vercel AI pattern). The text gradient sweeps
                       *  across the letters while we wait for the first delta. */}
                      {msg.content === '' && msg.streaming ? (
                        <div className={styles.thinking} aria-label="Thinking">
                          {/* Lucide "sparkles" — clean two-star outline.
                           *  Subtler than a brain shape and visually
                           *  matches the AI-product context. */}
                          <svg className={styles.thinkingIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M9.94 14.06a2 2 0 0 0-1.44-1.44L2.37 11.04a.5.5 0 0 1 0-.96l6.13-1.58A2 2 0 0 0 9.94 7.06l1.58-6.13a.5.5 0 0 1 .96 0l1.58 6.13a2 2 0 0 0 1.44 1.44l6.13 1.58a.5.5 0 0 1 0 .96l-6.13 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z" />
                            <path d="M20 3v4" />
                            <path d="M22 5h-4" />
                            <path d="M4 17v2" />
                            <path d="M5 18H3" />
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
