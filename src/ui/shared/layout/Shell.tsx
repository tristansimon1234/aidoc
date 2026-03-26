import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme.js'
import styles from './Shell.module.css'

interface ShellProps {
  children: ReactNode
  actions?: ReactNode
  fullWidth?: boolean
}

export function Shell({ children, actions, fullWidth = false }: ShellProps): React.ReactElement {
  const { theme, toggle } = useTheme()

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Link to="/" className={styles.logo}>
          aidoc
        </Link>
        <nav className={styles.nav}>
          <button
            className={styles.themeToggle}
            onClick={toggle}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          {actions}
        </nav>
      </header>
      <main className={fullWidth ? styles.mainFull : styles.main}>{children}</main>
    </div>
  )
}
