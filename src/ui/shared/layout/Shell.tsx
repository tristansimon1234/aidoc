import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import styles from './Shell.module.css'

interface ShellProps {
  children: ReactNode
  actions?: ReactNode
}

export function Shell({ children, actions }: ShellProps): React.ReactElement {
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Link to="/" className={styles.logo}>
          aidoc
        </Link>
        {actions && <nav className={styles.nav}>{actions}</nav>}
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  )
}
