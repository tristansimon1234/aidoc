import type { RunStepDTO } from '../../../shared/api/client.js'
import styles from './StepTimeline.module.css'

interface StepTimelineProps {
  steps: RunStepDTO[]
}

export function StepTimeline({ steps }: StepTimelineProps): React.ReactElement {
  return (
    <div className={styles.timeline}>
      {steps.map((step) => {
        const statusCls = step.status === 'blocked' ? styles.blocked : step.status === 'skipped' ? styles.skipped : ''

        return (
          <div key={step.id} className={`${styles.step} ${statusCls}`}>
            <span className={styles.index}>{step.stepIndex + 1}</span>
            <div className={styles.content}>
              <p className={styles.action}>{step.action ?? 'No action'}</p>
              {step.observation && <p className={styles.observation}>{step.observation}</p>}
              {step.url && <p className={styles.stepUrl}>{step.url}</p>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
