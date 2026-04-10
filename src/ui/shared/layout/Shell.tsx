import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme.js'
import styles from './Shell.module.css'

interface ShellProps {
  children: ReactNode
  actions?: ReactNode
  navBar?: ReactNode
  fullWidth?: boolean
}

export function Shell({ children, actions, navBar, fullWidth = false }: ShellProps): React.ReactElement {
  const { theme, toggle } = useTheme()

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.topbarLeft}>
          <Link to="/" className={styles.logo}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
              <path d="M14 2v4a2 2 0 0 0 2 2h4" />
              <circle cx="10" cy="16" r="2" fill="currentColor" stroke="none" />
              <path d="M14 14l-2.5 2.5" />
            </svg>
            <span>aidoc</span>
          </Link>
          {actions}
        </div>
        <nav className={styles.nav}>
          {navBar}
          <div className={styles.navDivider} />
          <button
            className={styles.iconBtn}
            onClick={toggle}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>
            )}
          </button>
        </nav>
      </header>
      <main className={fullWidth ? styles.mainFull : styles.main}>{children}</main>
    </div>
  )
}
