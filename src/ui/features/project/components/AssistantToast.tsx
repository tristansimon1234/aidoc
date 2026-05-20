import { useEffect, useState } from 'react'
import styles from './AssistantToast.module.css'

export interface AssistantToastData {
  id: string
  message: string
  actionLabel?: string
  onAction?: () => void | Promise<void>
  durationMs?: number
}

interface AssistantToastProps {
  toast: AssistantToastData | null
  onDismiss: () => void
}

/** Tiny in-panel toast for chat-driven actions: "Updated X · Undo". */
export function AssistantToast({ toast, onDismiss }: AssistantToastProps): React.ReactElement | null {
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!toast) return
    const ms = toast.durationMs ?? 8000
    const timer = setTimeout(onDismiss, ms)
    return () => clearTimeout(timer)
  }, [toast, onDismiss])

  if (!toast) return null

  const handleAction = async (): Promise<void> => {
    if (!toast.onAction) return
    setBusy(true)
    try {
      await toast.onAction()
    } finally {
      setBusy(false)
      onDismiss()
    }
  }

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span className={styles.message}>{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button
          type="button"
          className={styles.action}
          onClick={() => { void handleAction() }}
          disabled={busy}
        >
          {busy ? '…' : toast.actionLabel}
        </button>
      )}
      <button
        type="button"
        className={styles.dismiss}
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18" /><path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  )
}
