import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { useAuth } from '../hooks/useAuth.js'
import { useTheme } from '../hooks/useTheme.js'
import { AvatarMenu } from './AvatarMenu.js'
import styles from './AppRail.module.css'

const FEEDBACK_EMBED_BASE =
  'https://grave-clutch-91b.notion.site/ebd/4f758e66cecd42048cb9f6709d69fb74'

export function AppRail(): React.ReactElement {
  const location = useLocation()
  const { theme, toggle } = useTheme()
  const { user } = useAuth()
  const isHome = location.pathname === '/'
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  const feedbackUrl = useMemo(() => {
    const email = user?.email
    if (!email) return FEEDBACK_EMBED_BASE
    const params = new URLSearchParams({ Email: email })
    return `${FEEDBACK_EMBED_BASE}?${params.toString()}`
  }, [user?.email])

  useEffect(() => {
    if (!feedbackOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFeedbackOpen(false)
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [feedbackOpen])

  return (
    <aside className={styles.rail}>
      <div className={styles.top}>
        <Link to="/" className={styles.logo} aria-label="Home">
          <img
            src="https://xpcacqvwnfdkvmqbeeqp.supabase.co/storage/v1/object/public/website/playd-appicon-purple.png"
            alt="doclee"
            className={styles.logoImg}
          />
        </Link>

        <Link
          to="/"
          className={`${styles.navBtn} ${isHome ? styles.navBtnActive : ''}`}
          aria-label="Projects"
          title="Projects"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </Link>
      </div>

      <div className={styles.bottom}>
        <button
          type="button"
          className={styles.feedbackButton}
          onClick={() => setFeedbackOpen(true)}
          aria-label="Give us feedback"
          title="Give us feedback"
        >
          <svg className={styles.feedbackIcon} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          <span className={styles.feedbackLabel}>Feedback</span>
        </button>
        <a
          className={styles.docsButton}
          href="https://app.doclee.tech/docs/d8577a1d-b81b-4c0b-b009-25b351a6376a"
          target="_blank"
          rel="noreferrer"
          aria-label="Visit Doclee docs"
        >
          <svg className={styles.docsIcon} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          <span className={styles.docsLabel}>Visit Docs</span>
        </a>
        <button
          className={styles.navBtn}
          onClick={toggle}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>
          )}
        </button>
        <AvatarMenu />
      </div>

      {feedbackOpen
        ? createPortal(
            <div
              className={styles.modalBackdrop}
              role="dialog"
              aria-modal="true"
              aria-label="Give us feedback"
              onClick={() => setFeedbackOpen(false)}
            >
              <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                  <span className={styles.modalTitle}>Give us feedback</span>
                  <button
                    type="button"
                    className={styles.modalClose}
                    onClick={() => setFeedbackOpen(false)}
                    aria-label="Close"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                <iframe
                  src={feedbackUrl}
                  title="Doclee feedback form"
                  className={styles.modalIframe}
                  allowFullScreen
                />
              </div>
            </div>,
            document.body
          )
        : null}
    </aside>
  )
}
