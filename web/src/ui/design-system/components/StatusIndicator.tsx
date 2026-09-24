import type { StatusKey } from '../tokens.js'
import styles from './StatusIndicator.module.css'

interface StatusIndicatorProps {
  status: StatusKey
  label?: string
}

export function StatusIndicator({ status, label }: StatusIndicatorProps): React.ReactElement {
  const displayLabel = label ?? status

  return (
    <span className={`${styles.indicator} ${styles[status]}`}>
      <span className={styles.dot} />
      {displayLabel}
    </span>
  )
}
