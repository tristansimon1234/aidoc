import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Tooltip } from '../../../design-system/components/index.js'
import { ChatSurface, type ChatSurfaceApi, type ChatMessage } from '../../chat/components/ChatSurface.js'
import { api, type DocPageDTO } from '../../../shared/api/client.js'
import { AssistantToast, type AssistantToastData } from './AssistantToast.js'
import styles from './ProjectAssistantPanel.module.css'

interface ProjectAssistantPanelProps {
  open: boolean
  onClose: () => void
  projectId: string
  projectName: string
  /** Flat list of project pages — used so the assistant can mention the
   *  user's currently-viewed page by name. Optional; the panel just sends
   *  the URL path when not provided. */
  pages?: DocPageDTO[]
  messages: ChatMessage[]
  onMessagesChange: (next: ChatMessage[]) => void
  pendingMessage: string | null
  onPendingMessageConsumed: () => void
  /** Video file dropped on the chat bar — forwarded to the next
   *  prepare_doc_generation upload block as a preselected file. */
  pendingVideo?: File | null
  onPendingVideoConsumed?: () => void
  /** Called when the AI mutates the project (creates/updates/publishes a
   *  page) — the host uses it to refresh the page tree / sidebar. */
  onProjectMutation?: () => void | Promise<void>
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
 *  endpoint so every turn benefits from Doclee platform context. Accepts
 *  a `getUserContext` callback read at send-time so the AI always knows
 *  the user's current location (page + URL) when they ask. */
function buildAssistantApi(
  projectId: string,
  getUserContext: () => Record<string, string>,
): ChatSurfaceApi {
  return {
    send: (_pid, message, history, sessionToken) =>
      api.chat.sendAssistant(projectId, message, history, sessionToken, getUserContext()),
    sendStream: (_pid, message, history, sessionToken, signal) =>
      api.chat.sendAssistantStream(projectId, message, history, sessionToken, signal, getUserContext()),
    suggestions: () => api.chat.suggestions(projectId),
  }
}

export function ProjectAssistantPanel({
  open,
  onClose,
  projectId,
  projectName,
  pages,
  messages,
  onMessagesChange,
  pendingMessage,
  onPendingMessageConsumed,
  pendingVideo,
  onPendingVideoConsumed,
  onProjectMutation,
  sessionToken,
}: ProjectAssistantPanelProps): React.ReactElement {
  const navigate = useNavigate()
  const location = useLocation()
  const [toast, setToast] = useState<AssistantToastData | null>(null)

  // Keep current location info in a ref so the API closure reads the
  // freshest values without needing to be rebuilt on every navigation.
  const locationContextRef = useRef<{ path: string; pageTitle: string | null; pageSlug: string | null }>({
    path: location.pathname,
    pageTitle: null,
    pageSlug: null,
  })

  useEffect(() => {
    // Detect /projects/:pid/pages/:pageId in the path and resolve the page title
    const m = location.pathname.match(/\/projects\/[^/]+\/pages\/([^/?#]+)/)
    const pageIdOrSlug = m ? m[1] : null
    const page = pageIdOrSlug && pages
      ? pages.find((p) => p.id === pageIdOrSlug || p.slug === pageIdOrSlug)
      : undefined
    locationContextRef.current = {
      path: location.pathname,
      pageTitle: page?.title ?? null,
      pageSlug: page?.slug ?? null,
    }
  }, [location.pathname, pages])

  const assistantApi = useMemo(
    () => buildAssistantApi(projectId, () => {
      const { path, pageTitle, pageSlug } = locationContextRef.current
      const ctx: Record<string, string> = {
        currentUrl: typeof window !== 'undefined' ? `${window.location.origin}${path}` : path,
      }
      if (pageTitle && pageSlug) {
        ctx.extra = `Currently viewing page: "${pageTitle}" (slug: ${pageSlug}). If the user says "this page" or "here", they mean this one.`
      } else if (path.includes('/projects/') && !path.includes('/pages/')) {
        ctx.extra = `Currently on the project overview (no specific page open). The user may ask about creating or finding pages.`
      }
      return ctx
    }),
    [projectId],
  )

  // Handler for any tool-driven mutation. update_page also wires an Undo
  // toast that restores the previous content.
  const handleProjectMutation = useCallback((info: {
    tool: string
    pageId?: string
    pageSlug?: string
    pageTitle?: string
    previousContent?: string | null
  }): void => {
    // Refetch the page tree so the sidebar reflects the AI's action
    void onProjectMutation?.()

    if (info.tool === 'update_page' && info.pageId && typeof info.previousContent === 'string') {
      const pageId = info.pageId
      const title = info.pageTitle ?? 'page'
      setToast({
        id: `undo_${pageId}_${Date.now()}`,
        message: `Updated "${title}"`,
        actionLabel: 'Undo',
        durationMs: 10000,
        onAction: async () => {
          try {
            await api.pages.restorePrevious(projectId, pageId)
            await onProjectMutation?.()
          } catch (err) {
            console.error('[AssistantPanel] Undo failed:', (err as Error).message)
          }
        },
      })
    } else if (info.tool === 'create_page' && info.pageTitle) {
      setToast({
        id: `created_${info.pageId}_${Date.now()}`,
        message: `Created "${info.pageTitle}"`,
      })
    } else if (info.tool === 'publish_page' && info.pageTitle) {
      setToast({
        id: `pub_${info.pageId}_${Date.now()}`,
        message: `Visibility updated for "${info.pageTitle}"`,
      })
    }
  }, [onProjectMutation, projectId])

  const handleAutoNavigate = useCallback((info: { pageId: string; pageSlug: string }): void => {
    navigate(`/projects/${projectId}/pages/${info.pageId}`)
    onClose()
  }, [navigate, projectId, onClose])

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

  const handleSourceClick = (source: { pageId: string; tab?: string }): void => {
    const url = `/projects/${projectId}/pages/${source.pageId}${source.tab ? `?tab=${source.tab}` : ''}`
    navigate(url)
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
            onProjectMutation={handleProjectMutation}
            onAutoNavigate={handleAutoNavigate}
            variant="sidepanel"
          />
          <AssistantToast toast={toast} onDismiss={() => setToast(null)} />
        </div>
      </aside>
    </>
  )
}
