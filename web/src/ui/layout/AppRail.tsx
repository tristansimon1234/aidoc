import { Link, useLocation } from 'react-router-dom'
import { useTheme } from './useTheme'
import { AvatarMenu } from './AvatarMenu'
import styles from './AppRail.module.css'

export function AppRail({ email }: { email: string }) {
  const location = useLocation()
  const { theme, toggle } = useTheme()

  return (
    <aside className={`${styles.rail} no-print`}>
      <div className={styles.top}>
        <Link to="/" className={styles.logo} aria-label="Accueil">
          <span className={styles.logoMark}>d</span>
        </Link>

        <Link
          to="/"
          className={`${styles.navBtn} ${location.pathname === '/' ? styles.navBtnActive : ''}`}
          aria-label="Mes procédures"
          title="Mes procédures"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </Link>

        <Link
          to="/credits"
          className={`${styles.navBtn} ${location.pathname === '/credits' ? styles.navBtnActive : ''}`}
          aria-label="Crédits"
          title="Crédits"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <line x1="2" y1="10" x2="22" y2="10" />
          </svg>
        </Link>
      </div>

      <div className={styles.bottom}>
        <button
          className={styles.navBtn}
          onClick={toggle}
          aria-label={theme === 'dark' ? 'Mode clair' : 'Mode sombre'}
          title={theme === 'dark' ? 'Mode clair' : 'Mode sombre'}
        >
          {theme === 'dark' ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2" />
              <path d="M12 20v2" />
              <path d="m4.93 4.93 1.41 1.41" />
              <path d="m17.66 17.66 1.41 1.41" />
              <path d="M2 12h2" />
              <path d="M20 12h2" />
              <path d="m6.34 17.66-1.41 1.41" />
              <path d="m19.07 4.93-1.41 1.41" />
            </svg>
          ) : (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
            </svg>
          )}
        </button>
        <AvatarMenu email={email} />
      </div>
    </aside>
  )
}
