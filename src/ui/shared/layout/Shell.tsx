import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { JobTracker, JobBadge } from '../jobs/JobTracker.js'
import { AppRail } from './AppRail.js'
import { QuotaBanner } from './QuotaBanner.js'
import styles from './Shell.module.css'

interface ShellProps {
  children: ReactNode
  actions?: ReactNode
  navBar?: ReactNode
  fullWidth?: boolean
}

const DOCLEE_WIDGET_ID = 'doclee-self-widget'

/** Inject Doclee's own widget on first Shell mount, remove on unmount.
 *  Scoped to the admin Shell so the public-docs SPA — which renders its
 *  own native chat launcher — doesn't load a second one on top. The
 *  widget itself dedupes via #aidoc-widget-btn but we still want a clean
 *  removal on route change to /docs/*. */
function useDocleeSelfWidget(): void {
  useEffect(() => {
    if (document.getElementById(DOCLEE_WIDGET_ID)) return
    const s = document.createElement('script')
    s.id = DOCLEE_WIDGET_ID
    s.src = 'https://app.doclee.tech/widget.js'
    s.setAttribute('data-key', 'aidoc_0cec656e9890c2ffd68c2d2e04d8b986d2d1d224e55a49c7')
    s.setAttribute('data-cfg', '{"accentColor":"#9755ce","bgColor":"#FFFFFF","textColor":"#1A1A1A","font":"\\"Geist\\", sans-serif","widgetPosition":"right"}')
    document.body.appendChild(s)
    return () => {
      document.getElementById(DOCLEE_WIDGET_ID)?.remove()
      // Tear down any UI the widget injected so navigating to /docs/*
      // (where Shell unmounts) doesn't leave the launcher floating.
      ;[
        '#aidoc-widget-btn', '#aidoc-widget-panel', '#aidoc-wt-bar',
        '#aidoc-wt-overlay', '#aidoc-wt-ring', '#aidoc-wt-tooltip',
      ].forEach((sel) => document.querySelector(sel)?.remove())
    }
  }, [])
}

export function Shell({ children, actions, navBar, fullWidth = false }: ShellProps): React.ReactElement {
  useDocleeSelfWidget()
  return (
    <div className={styles.shell}>
      <AppRail />
      <div className={styles.body}>
        <QuotaBanner />
        <header className={styles.topbar}>
          <div className={styles.topbarLeft}>
            <Link to="/" className={styles.logo} aria-label="doclee">
              <img
                src="https://xpcacqvwnfdkvmqbeeqp.supabase.co/storage/v1/object/public/website/playd-lockup-transparent.png"
                alt="doclee"
                className={styles.logoImg}
              />
            </Link>
            <JobBadge />
            {actions}
          </div>
          <nav className={styles.nav}>
            {navBar}
          </nav>
        </header>
        <main className={fullWidth ? styles.mainFull : styles.main}>{children}</main>
        <JobTracker />
      </div>
    </div>
  )
}
