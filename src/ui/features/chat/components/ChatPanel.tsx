import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Spinner } from '../../../design-system/components/index.js'
import { api, type ChatResponseDTO } from '../../../shared/api/client.js'
import { MarkdownRenderer } from '../../../design-system/components/index.js'
import styles from './ChatPanel.module.css'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: { pageId: string; pageTitle: string; pageSlug: string }[]
  followUps?: string[]
}

const FALLBACK_SUGGESTIONS = [
  'How does this product work?',
  'What are the main features?',
]

export function ChatPanel({
  projectId,
  projectName,
  onClose,
  inline = false,
}: {
  projectId: string
  projectName: string
  onClose: () => void
  inline?: boolean
}): React.ReactElement {
  const navigate = useNavigate()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [indexed, setIndexed] = useState<boolean | null>(null)
  const [indexError, setIndexError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>(FALLBACK_SUGGESTIONS)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void checkAndIndex()
  }, [projectId])

  useEffect(() => {
    if (indexed && !sending) inputRef.current?.focus()
  }, [indexed, sending])

  const checkAndIndex = async (): Promise<void> => {
    try {
      setIndexing(true)
      const result = await api.chat.index(projectId)
      setIndexed(result.indexed > 0)
      if (result.indexed > 0) {
        api.chat.suggestions(projectId)
          .then((r) => { if (r.suggestions.length > 0) setSuggestions(r.suggestions) })
          .catch(() => {})
      }
    } catch (err) {
      setIndexError((err as Error).message)
      setIndexed(false)
    } finally {
      setIndexing(false)
    }
  }

  const scrollToBottom = (): void => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => { scrollToBottom() }, [messages])

  const sendMessage = async (text: string): Promise<void> => {
    const msg = text.trim()
    if (!msg || sending) return

    setInput('')
    const userMsg: ChatMessage = { role: 'user', content: msg }
    setMessages((prev) => [...prev, userMsg])
    setSending(true)

    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content }))
      const response: ChatResponseDTO = await api.chat.send(projectId, msg, history)

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: response.answer, sources: response.sources, followUps: response.followUps },
      ])
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Sorry, something went wrong. Please try again.` },
      ])
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage(input)
    }
  }

  const panelClass = inline ? styles.panelInline : styles.panel

  return (
    <>
      {!inline && <div className={styles.overlay} onClick={onClose} />}
      <div className={panelClass}>
        <div className={styles.header}>
          <span className={styles.title}>Chat with docs</span>
          {!inline && <button className={styles.closeBtn} onClick={onClose}>&times;</button>}
        </div>

        {indexing ? (
          <div className={styles.emptyState}>
            <Spinner size="sm" />
            <span className={styles.emptyHint}>Indexing documentation...</span>
          </div>
        ) : indexed === false ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyTitle}>{indexError ? 'Indexing failed' : 'No documentation yet'}</span>
            <span className={styles.emptyHint}>
              {indexError
                ? `Something went wrong: ${indexError}`
                : 'Generate documentation for your pages first. The chat will use it to answer your questions.'
              }
            </span>
            {indexError && (
              <button className={styles.retryBtn} onClick={() => { setIndexError(null); void checkAndIndex() }}>
                Retry
              </button>
            )}
          </div>
        ) : (
          <>
            <div className={styles.messages}>
              {messages.length === 0 ? (
                <div className={styles.welcome}>
                  <div>
                    <div className={styles.welcomeGreeting}>
                      Hi! I know everything about {projectName}.
                    </div>
                    <p className={styles.welcomeHint}>
                      Ask me anything about the documentation. I'll find the relevant sections and give you a clear answer.
                    </p>
                  </div>

                  <div className={styles.suggestions}>
                    <span className={styles.suggestionsLabel}>Try asking</span>
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        className={styles.suggestion}
                        onClick={() => void sendMessage(s)}
                        disabled={sending}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {messages.map((msg, i) => (
                    <div key={i} className={`${styles.message} ${msg.role === 'user' ? styles.messageUser : styles.messageAssistant}`}>
                      {msg.role === 'assistant' ? (
                        <MarkdownRenderer content={msg.content} />
                      ) : (
                        msg.content
                      )}
                      {msg.followUps && msg.followUps.length > 0 && i === messages.length - 1 && !sending && (
                        <div className={styles.followUps}>
                          {msg.followUps.map((q) => (
                            <button
                              key={q}
                              className={styles.followUp}
                              onClick={() => void sendMessage(q)}
                            >
                              {q}
                            </button>
                          ))}
                        </div>
                      )}
                      {msg.sources && msg.sources.length > 0 && (
                        <div className={styles.sources}>
                          <span className={styles.sourcesLabel}>Sources</span>
                          {msg.sources.map((s) => (
                            <button
                              key={s.pageSlug}
                              className={styles.sourceTag}
                              onClick={() => {
                                onClose()
                                navigate(`/projects/${projectId}/pages/${s.pageId}`)
                              }}
                            >
                              {s.pageTitle}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {sending && (
                    <div className={styles.thinking}>
                      <Spinner size="sm" />
                      <span>Searching docs...</span>
                    </div>
                  )}
                </>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className={styles.inputBar}>
              <input
                ref={inputRef}
                className={styles.input}
                placeholder="Ask a question..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={sending}
              />
              <button
                className={styles.sendBtn}
                onClick={() => void sendMessage(input)}
                disabled={!input.trim() || sending}
              >
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}
