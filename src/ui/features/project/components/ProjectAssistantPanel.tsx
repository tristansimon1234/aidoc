import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tooltip } from '../../../design-system/components/index.js'
import { ChatSurface, type ChatSurfaceApi, type ChatMessage } from '../../chat/components/ChatSurface.js'
import { api } from '../../../shared/api/client.js'
import styles from './ProjectAssistantPanel.module.css'

interface ProjectAssistantPanelProps {
  open: boolean
  onClose: () => void
  projectId: string
  projectName: string
  messages: ChatMessage[]
  onMessagesChange: (next: ChatMessage[]) => void
  pendingMessage: string | null
  onPendingMessageConsumed: () => void
  /** Video file dropped on the chat bar — forwarded to the next
   *  prepare_doc_generation upload block as a preselected file. */
  pendingVideo?: File | null
  onPendingVideoConsumed?: () => void
  sessionToken?: string
}

const ASSISTANT_SUGGESTIONS = [
  'Generate documentation from a screen recording',
  'Create a new page about onboarding',
  'List all the pages in this project',
  'Run a Try Doc test on my latest page',
  'How do I embed the chat widget on my app?',
]

/** Build a ChatSurfaceApi adapter that routes through the assistant-mode
 *  endpoint so every turn benefits from Doclee platform context. */
function buildAssistantApi(projectId: string): ChatSurfaceApi {
  return {
    send: (_pid, message, history, sessionToken) =>
      api.chat.sendAssistant(projectId, message, history, sessionToken),
    sendStream: (_pid, message, history, sessionToken, signal) =>
      api.chat.sendAssistantStream(projectId, message, history, sessionToken, signal),
    suggestions: () => api.chat.suggestions(projectId),
  }
}

export function ProjectAssistantPanel({
  open,
  onClose,
  projectId,
  projectName,
  messages,
  onMessagesChange,
  pendingMessage,
  onPendingMessageConsumed,
  pendingVideo,
  onPendingVideoConsumed,
  sessionToken,
}: ProjectAssistantPanelProps): React.ReactElement {
  const navigate = useNavigate()

  const assistantApi = useMemo(() => buildAssistantApi(projectId), [projectId])

  // When a video is dropped on the chat bar, trigger a generation message
  // so the AI calls prepare_doc_generation and the VideoUploadBlock appears
  // pre-filled with the dropped file.
  const effectivePendingMessage = pendingVideo && !pendingMessage
    ? `Generate documentation for "${pendingVideo.name.replace(/\.[^.]+$/, '')}" — I just dropped a video.`
    : pendingMessage

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const handleSourceClick = (source: { pageId: string }): void => {
    navigate(`/projects/${projectId}/pages/${source.pageId}`)
    onClose()
  }

  const handleReset = (): void => onMessagesChange([])

  return (
    <>
      <div
        className={`${styles.overlay} ${open ? styles.overlayVisible : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`${styles.panel} ${open ? styles.panelOpen : ''}`}
        role="dialog"
        aria-label="Project assistant"
        aria-hidden={!open}
      >
        <header className={styles.header}>
          <div className={styles.headerTitle}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.34 6.34l-1.41-1.41M19.07 19.07l-1.41-1.41M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span>Assistant</span>
            <span className={styles.headerScope}>{projectName}</span>
          </div>
          <div className={styles.headerActions}>
            {messages.length > 0 && (
              <Tooltip content="New conversation" placement="bottom">
                <button className={styles.iconBtn} onClick={handleReset} aria-label="New conversation">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9" /><polyline points="3 4 3 10 9 10" />
                  </svg>
                </button>
              </Tooltip>
            )}
            <Tooltip content="Close (Esc)" placement="bottom">
              <button className={styles.iconBtn} onClick={onClose} aria-label="Close assistant">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
              </button>
            </Tooltip>
          </div>
        </header>
        <div className={styles.body}>
          <ChatSurface
            projectId={projectId}
            projectName={projectName}
            api={assistantApi}
            onSourceClick={handleSourceClick}
            sessionToken={sessionToken}
            fallbackSuggestions={ASSISTANT_SUGGESTIONS}
            messages={messages}
            onMessagesChange={onMessagesChange}
            pendingMessage={effectivePendingMessage}
            onPendingMessageConsumed={() => {
              onPendingMessageConsumed()
              // Note: don't clear pendingVideo here — it's claimed by the
              // first VideoUploadBlock that mounts (see ChatSurface).
            }}
            pendingVideo={pendingVideo ?? null}
            onPendingVideoConsumed={onPendingVideoConsumed}
            variant="sidepanel"
          />
        </div>
      </aside>
    </>
  )
}
