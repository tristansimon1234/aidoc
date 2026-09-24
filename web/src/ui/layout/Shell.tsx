import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { isLocalMode, loginDisabled } from '../../supabase'
import { Badge } from '../design-system/components'
import { AppRail } from './AppRail'
import styles from './Shell.module.css'

interface ShellProps {
  email: string
  credits: number | null
  children: ReactNode
}

/** Structure de toutes les pages connectées : rail à gauche, barre du haut, contenu centré. */
export function Shell({ email, credits, children }: ShellProps) {
  return (
    <div className={styles.shell}>
      <AppRail email={email} />
      <div className={styles.body}>
        <header className={`${styles.topbar} no-print`}>
          <div className={styles.topbarLeft}>
            <Link to="/" className={styles.logo}>
              <span>doclee</span>
            </Link>
            {loginDisabled && (
              <Badge color="amber">{isLocalMode ? 'Local mode' : 'Test mode'}</Badge>
            )}
          </div>
          <nav className={styles.nav}>
            <Link to="/credits" className={styles.credits}>
              {credits === null ? '…' : `${credits} credit${credits > 1 ? 's' : ''}`}
            </Link>
          </nav>
        </header>
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  )
}
