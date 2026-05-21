import type { ReactNode } from 'react'
import styles from './Badge.module.css'

interface BadgeProps {
  children: ReactNode
  color?: 'blue' | 'green' | 'amber' | 'red' | 'purple'
}

export function Badge({ children, color = 'blue' }: BadgeProps): React.ReactElement {
  return <span className={`${styles.badge} ${styles[color]}`}>{children}</span>
}
