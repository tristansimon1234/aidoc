import { useEffect } from 'react'
import { Tooltip } from '../../../design-system/components/index.js'
import { ChatSurface, type ChatSurfaceApi, type ChatMessage, type SourceMedia } from '../../chat/components/ChatSurface.js'
import styles from './DocsChatPanel.module.css'

interface DocsChatPanelProps {
  open: boolean
  onClose: () => void
  /** Optional: when provided, an "expand" icon in the header navigates
   *  the user to the full-page chat view. The same conversation state
   *  is shared with that view through the parent's useDocsChat hook, so
   *  the user can keep going without losing context. */
  onExpand?: () => void
  projectId: string
  projectName: string
  api: ChatSurfaceApi
  messages: ChatMessage[]
  onMessagesChange: (next: ChatMessage[]) => void
  pendingMessage: string | null
  onPendingMessageConsumed: () => void
  onSourceClick: (source: { pageId: string; pageTitle: string; pageSlug: string }) => void
  onReset: () => void
  resolveSourceMedia?: (source: { pageId: string; pageSlug: string }) => SourceMedia | null | undefined
  sessionToken?: string
}

/**
 * Right-side chat panel for the public docs. Slides in from the right
 * (transform: translateX) and floats over the content — no reflow, no
 * content displacement. Mobile (<720px) collapses to full-width with a
 * dismiss overlay behind it.
 */
export function DocsChatPanel({
  open,
  onClose,
  onExpand,
  projectId,
  projectName,
  api,
  messages,
  onMessagesChange,
  pendingMessage,
  onPendingMessageConsumed,
  onSourceClick,
  onReset,
  resolveSourceMedia,
  sessionToken,
}: DocsChatPanelProps): React.ReactElement {
  // Close on Escape — matches dialog-style affordances elsewhere in the
  // app. Only listen while open so we don't add a handler for nothing.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

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
        aria-label="Documentation assistant"
        aria-hidden={!open}
      >
        <header className={styles.header}>
          <div className={styles.headerTitle}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v2" /><path d="M12 19v2" /><path d="M5 12H3" /><path d="M21 12h-2" />
              <path d="m6.34 6.34-1.41-1.41" /><path d="m19.07 19.07-1.41-1.41" />
              <path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span>Assistant</span>
          </div>
          <div className={styles.headerActions}>
            {messages.length > 0 && (
              <Tooltip content="Nouvelle conversation" placement="bottom">
                <button className={styles.iconBtn} onClick={onReset} aria-label="New conversation">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9" /><polyline points="3 4 3 10 9 10" />
                  </svg>
                </button>
              </Tooltip>
            )}
            {onExpand && (
              <Tooltip content="Agrandir" placement="bottom">
                <button className={styles.iconBtn} onClick={onExpand} aria-label="Expand to full page">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h6v6" /><path d="M9 21H3v-6" />
                    <path d="M21 3l-7 7" /><path d="M3 21l7-7" />
                  </svg>
                </button>
              </Tooltip>
            )}
            <Tooltip content="Fermer (Esc)" placement="bottom">
              <button className={styles.iconBtn} onClick={onClose} aria-label="Close assistant">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            api={api}
            onSourceClick={onSourceClick}
            sessionToken={sessionToken}
            resolveSourceMedia={resolveSourceMedia}
            messages={messages}
            onMessagesChange={onMessagesChange}
            pendingMessage={pendingMessage}
            onPendingMessageConsumed={onPendingMessageConsumed}
            variant="sidepanel"
          />
        </div>
      </aside>
    </>
  )
}
