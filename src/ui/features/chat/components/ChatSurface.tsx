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
}

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
  send: (
    projectId: string,
    message: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    sessionToken?: string,
  ) => Promise<ChatResponseDTO>
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

/**
 * Compact narrated video player for chat responses — same voice-over
 * semantics as PublicDocs.NarratedVideo: video forced muted so the
 * original track never plays over the ElevenLabs narration, volume
 * slider piped to the audio element. Tight height so it sits nicely
 * inside an assistant bubble.
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
 * The polished chat UI surface — welcome state with suggestion chips,
 * message bubbles with avatar, sources and follow-ups, thinking dots,
 * auto-resize input. Used by admin ChatPage and the public-docs chat
 * route so both surfaces look identical except for theming.
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
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void checkAndIndex()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => {
    if (indexed && !sending) inputRef.current?.focus()
  }, [indexed, sending])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const checkAndIndex = async (): Promise<void> => {
    // Nothing to check when the caller didn't provide status/index —
    // assume ready (public docs) and move straight into chat.
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

  const sendMessage = useCallback(async (text: string): Promise<void> => {
    const msg = text.trim()
    if (!msg || sending) return

    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: msg }])
    setSending(true)

    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content }))
      const response = await api.send(projectId, msg, history, sessionToken)
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: response.answer,
          sources: response.sources,
          followUps: response.followUps,
          walkthroughAvailable: response.walkthroughAvailable,
        },
      ])
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' },
      ])
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }, [messages, sending, projectId, api, sessionToken])

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

  return (
    <div className={styles.page}>
      <div className={styles.chat}>
        <div className={styles.messages}>
          {messages.length === 0 ? (
            <div className={styles.welcome}>
              <div className={styles.welcomeIcon}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2C6.477 2 2 6.015 2 10.97c0 2.735 1.329 5.175 3.406 6.813.118.093.2.236.2.394L5.4 20.6a.85.85 0 0 0 1.254.745l2.663-1.472a.85.85 0 0 1 .562-.088c.7.14 1.426.215 2.171.215 5.523 0 10-4.015 10-8.97C22 6.015 17.523 2 12 2z" />
                </svg>
              </div>
              <h2 className={styles.welcomeTitle}>Chat with {projectName}</h2>
              <p className={styles.welcomeHint}>
                Ask anything about the documentation. I'll search through all published pages and give you a clear answer with sources.
              </p>
              <div className={styles.suggestionsGrid}>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    className={styles.suggestion}
                    onClick={() => void sendMessage(s)}
                    disabled={sending}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={styles.suggestionIcon}>
                      <path d="M13 7l5 5-5 5" /><path d="M6 12h12" />
                    </svg>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <div key={i} className={`${styles.msgRow} ${msg.role === 'user' ? styles.msgRowUser : styles.msgRowAssistant}`}>
                  {msg.role === 'assistant' && (
                    <div className={styles.avatar}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09z"/><path d="M18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456z"/></svg>
                    </div>
                  )}
                  <div className={`${styles.bubble} ${msg.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant}`}>
                    {msg.role === 'assistant' ? (
                      <MarkdownRenderer content={msg.content} />
                    ) : (
                      <span>{msg.content}</span>
                    )}

                    {msg.role === 'assistant' && msg.sources?.[0] && resolveSourceMedia && (() => {
                      // Only surface the video from the TOP-RANKED source
                      // (after rerank). This is the page the answer is most
                      // directly based on — if it has a walkthrough video,
                      // it's almost always relevant. Skipping tangential
                      // sources avoids the \"random video from source #3\"
                      // problem we saw with the broader match.
                      const primary = msg.sources[0]
                      const media = resolveSourceMedia(primary)
                      if (!media?.videoUrl) return null
                      return (
                        <div className={styles.sourceVideo}>
                          <ChatNarratedVideo
                            videoUrl={media.videoUrl}
                            audioUrl={media.audioUrl ?? undefined}
                          />
                          <p className={styles.sourceVideoHint}>
                            Clip from <strong>{primary.pageTitle}</strong>
                          </p>
                        </div>
                      )
                    })()}

                    {msg.sources && msg.sources.length > 0 && (
                      <div className={styles.sources}>
                        {msg.sources.map((s) => (
                          <button
                            key={s.pageSlug}
                            className={styles.sourceTag}
                            onClick={() => onSourceClick(s)}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></svg>
                            {s.pageTitle}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {!sending && messages.length > 0 && messages[messages.length - 1]?.role === 'assistant' && messages[messages.length - 1]?.followUps && (messages[messages.length - 1]?.followUps?.length ?? 0) > 0 && (
                <div className={styles.followUps}>
                  {(messages[messages.length - 1]?.followUps ?? []).map((q) => (
                    <button key={q} className={styles.followUp} onClick={() => void sendMessage(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              )}

              {sending && (
                <div className={styles.msgRow + ' ' + styles.msgRowAssistant}>
                  <div className={styles.avatar}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09z"/><path d="M18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456z"/></svg>
                  </div>
                  <div className={styles.thinking}>
                    <div className={styles.thinkingDots}>
                      <span /><span /><span />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className={styles.inputBar}>
          <div className={styles.inputWrapper}>
            <textarea
              ref={inputRef}
              className={styles.input}
              placeholder="Ask a question..."
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
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>
            </button>
          </div>
          <span className={styles.inputHint}>Searches documentation via RAG</span>
        </div>
      </div>
    </div>
  )
}
