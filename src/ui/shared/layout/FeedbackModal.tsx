import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './FeedbackModal.module.css'

const FEEDBACK_EMBED_URL =
  'https://grave-clutch-91b.notion.site/ebd/4f758e66cecd42048cb9f6709d69fb74'

interface FeedbackContextValue {
  open: () => void
  close: () => void
  isOpen: boolean
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null)

export function useFeedback(): FeedbackContextValue {
  const ctx = useContext(FeedbackContext)
  if (!ctx) throw new Error('useFeedback must be used within <FeedbackProvider>')
  return ctx
}

export function FeedbackProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [isOpen, setOpen] = useState(false)

  const open = useCallback(() => setOpen(true), [])
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [isOpen])

  const value = useMemo(() => ({ open, close, isOpen }), [open, close, isOpen])

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      {isOpen
        ? createPortal(
            <div
              className={styles.modalBackdrop}
              role="dialog"
              aria-modal="true"
              aria-label="Give us feedback"
              onClick={close}
            >
              <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                  <span className={styles.modalTitle}>Give us feedback</span>
                  <button
                    type="button"
                    className={styles.modalClose}
                    onClick={close}
                    aria-label="Close"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                <iframe
                  src={FEEDBACK_EMBED_URL}
                  title="Doclee feedback form"
                  className={styles.modalIframe}
                  allowFullScreen
                />
              </div>
            </div>,
            document.body
          )
        : null}
    </FeedbackContext.Provider>
  )
}
