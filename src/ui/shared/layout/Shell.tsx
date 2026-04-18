import type { ReactNode } from 'react'
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

export function Shell({ children, actions, navBar, fullWidth = false }: ShellProps): React.ReactElement {
  return (
    <div className={styles.shell}>
      <AppRail />
      <div className={styles.body}>
        <QuotaBanner />
        <header className={styles.topbar}>
          <div className={styles.topbarLeft}>
            <Link to="/" className={styles.logo}>
              <span>aidoc</span>
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
