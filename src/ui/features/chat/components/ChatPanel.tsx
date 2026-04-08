import { useState, useRef, useEffect } from 'react'
import { Spinner } from '../../../design-system/components/index.js'
import { api, type ChatResponseDTO } from '../../../shared/api/client.js'
import { MarkdownRenderer } from '../../../design-system/components/index.js'
import styles from './ChatPanel.module.css'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: { pageTitle: string; pageSlug: string }[]
}

export function ChatPanel({
  projectId,
  onClose,
}: {
  projectId: string
  onClose: () => void
}): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [indexed, setIndexed] = useState<boolean | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-index on first open if needed
  useEffect(() => {
    void checkAndIndex()
  }, [projectId])

  // Focus input on open
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const checkAndIndex = async (): Promise<void> => {
    try {
      setIndexing(true)
      const result = await api.chat.index(projectId)
      setIndexed(result.indexed > 0)
    } catch {
      setIndexed(false)
    } finally {
      setIndexing(false)
    }
  }

  const scrollToBottom = (): void => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => { scrollToBottom() }, [messages])

  const handleSend = async (): Promise<void> => {
    const msg = input.trim()
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
        { role: 'assistant', content: response.answer, sources: response.sources },
      ])
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${(err as Error).message}` },
      ])
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  return (
    <>
      <div className={styles.overlay} onClick={onClose} />
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.title}>Chat with docs</span>
          <button className={styles.closeBtn} onClick={onClose}>&times;</button>
        </div>

        {indexing ? (
          <div className={styles.emptyState}>
            <Spinner size="sm" />
            <span className={styles.emptyHint}>Indexing documentation...</span>
          </div>
        ) : indexed === false ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyTitle}>No documentation to chat with</span>
            <span className={styles.emptyHint}>
              Generate documentation for your pages first, then come back to chat.
            </span>
          </div>
        ) : (
          <>
            <div className={styles.messages}>
              {messages.length === 0 && (
                <div className={styles.emptyState}>
                  <span className={styles.emptyTitle}>Ask anything about your docs</span>
                  <span className={styles.emptyHint}>
                    Questions are answered using your project's documentation. Try asking about a feature, workflow, or concept.
                  </span>
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`${styles.message} ${msg.role === 'user' ? styles.messageUser : styles.messageAssistant}`}>
                  {msg.role === 'assistant' ? (
                    <MarkdownRenderer content={msg.content} />
                  ) : (
                    msg.content
                  )}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className={styles.sources}>
                      {msg.sources.map((s) => (
                        <span key={s.pageSlug} className={styles.sourceTag}>
                          {s.pageTitle}
                        </span>
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
              <div ref={messagesEndRef} />
            </div>

            <div className={styles.inputBar}>
              <input
                ref={inputRef}
                className={styles.input}
                placeholder="Ask about your documentation..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={sending}
              />
              <button
                className={styles.sendBtn}
                onClick={() => void handleSend()}
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
