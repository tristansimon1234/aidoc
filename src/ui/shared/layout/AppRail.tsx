import { Link, useLocation } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme.js'
import { AvatarMenu } from './AvatarMenu.js'
import styles from './AppRail.module.css'

export function AppRail(): React.ReactElement {
  const location = useLocation()
  const { theme, toggle } = useTheme()
  const isHome = location.pathname === '/'

  return (
    <aside className={styles.rail}>
      <div className={styles.top}>
        <Link to="/" className={styles.logo} aria-label="Home">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
            <path d="M14 2v4a2 2 0 0 0 2 2h4" />
            <circle cx="10" cy="16" r="2" fill="currentColor" stroke="none" />
            <path d="M14 14l-2.5 2.5" />
          </svg>
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
        <a
          className={styles.navBtn}
          href="https://app.doclee.tech/docs/d8577a1d-b81b-4c0b-b009-25b351a6376a"
          target="_blank"
          rel="noreferrer"
          aria-label="Doclee docs"
          title="Doclee docs"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
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
    </aside>
  )
}
