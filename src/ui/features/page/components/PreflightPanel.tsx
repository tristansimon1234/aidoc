import { Button } from '../../../design-system/components/index.js'
import type { PreflightResultDTO } from '../../../shared/api/client.js'
import styles from './PreflightPanel.module.css'

interface PreflightPanelProps {
  result: PreflightResultDTO
  onConfirm: () => void
  onDismiss: () => void
}

export function PreflightPanel({ result, onConfirm, onDismiss }: PreflightPanelProps): React.ReactElement {
  const missingCount = result.checks.filter((c) => c.status === 'missing').length

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Pre-flight Check</span>
        <span className={`${styles.badge} ${result.ready ? styles.badgeReady : styles.badgeBlocked}`}>
          {result.ready ? 'Ready' : `${missingCount} missing`}
        </span>
      </div>

      <div className={styles.testPlan}>
        {result.testPlan}
        <span className={styles.testPlanSteps}> (~{result.estimatedSteps} steps)</span>
      </div>

      <div className={styles.checks}>
        {result.checks.map((check, i) => (
          <div key={i} className={styles.checkItem}>
            <span className={`${styles.checkDot} ${
              check.status === 'ready' ? styles.dotReady
                : check.status === 'missing' ? styles.dotMissing
                  : styles.dotWarning
            }`} />
            <div className={styles.checkContent}>
              <div className={styles.checkLabel}>{check.label}</div>
              <div className={styles.checkDetail}>{check.detail}</div>
              {check.resolution && check.status !== 'ready' && (
                <div className={styles.checkResolution}>{check.resolution}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.actions}>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
        {!result.ready && (
          <Button size="sm" variant="ghost" onClick={onConfirm}>
            Run anyway
          </Button>
        )}
        <Button size="sm" onClick={onConfirm}>
          {result.ready ? 'Confirm & start' : 'Confirm & start'}
        </Button>
      </div>
    </div>
  )
}
