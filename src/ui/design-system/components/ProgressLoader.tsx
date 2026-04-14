import { useState, useEffect, useRef } from 'react'
import styles from './ProgressLoader.module.css'

interface ProgressStep {
  label: string
  /** Estimated duration in seconds */
  estimatedSeconds: number
}

interface ProgressLoaderProps {
  /** Sequential steps with time estimates */
  steps: ProgressStep[]
  /** Index of the currently active step (0-based) */
  activeStep: number
  /** Override status message */
  statusMessage?: string | null
}

export function ProgressLoader({ steps, activeStep, statusMessage }: ProgressLoaderProps): React.ReactElement {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(Date.now())

  // Reset timer when active step changes
  useEffect(() => {
    startRef.current = Date.now()
    setElapsed(0)
  }, [activeStep])

  // Tick every 200ms
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed((Date.now() - startRef.current) / 1000)
    }, 200)
    return () => clearInterval(interval)
  }, [activeStep])

  // Calculate total estimated time and progress
  const totalEstimated = steps.reduce((sum, s) => sum + s.estimatedSeconds, 0)
  const completedTime = steps.slice(0, activeStep).reduce((sum, s) => sum + s.estimatedSeconds, 0)
  const currentStep = steps[activeStep]
  const currentEstimated = currentStep?.estimatedSeconds ?? 10

  // Progress within current step: ease out so it slows near 100%
  const rawStepProgress = Math.min(elapsed / currentEstimated, 0.95)
  const easedStepProgress = 1 - Math.pow(1 - rawStepProgress, 3) // cubic ease-out, caps at ~95%

  const overallProgress = Math.min(
    (completedTime + easedStepProgress * currentEstimated) / totalEstimated,
    0.98,
  )

  // Time remaining estimate
  const remainingCurrent = Math.max(0, currentEstimated - elapsed)
  const remainingFuture = steps.slice(activeStep + 1).reduce((sum, s) => sum + s.estimatedSeconds, 0)
  const totalRemaining = Math.ceil(remainingCurrent + remainingFuture)

  const formatRemaining = (secs: number): string => {
    if (secs <= 0) return 'almost done...'
    if (secs < 60) return `~${secs}s remaining`
    const mins = Math.floor(secs / 60)
    const s = secs % 60
    return `~${mins}m ${s > 0 ? `${s}s` : ''} remaining`
  }

  return (
    <div className={styles.container}>
      {/* Progress bar */}
      <div className={styles.barTrack}>
        <div
          className={styles.barFill}
          style={{ width: `${overallProgress * 100}%` }}
        >
          <div className={styles.barShimmer} />
        </div>
      </div>

      {/* Status line */}
      <div className={styles.info}>
        <span className={styles.status}>
          {statusMessage ?? currentStep?.label ?? 'Processing...'}
        </span>
        <span className={styles.time}>
          {formatRemaining(totalRemaining)}
        </span>
      </div>

      {/* Step indicators */}
      {steps.length > 1 && (
        <div className={styles.steps}>
          {steps.map((step, i) => (
            <div key={i} className={`${styles.step} ${i < activeStep ? styles.stepDone : i === activeStep ? styles.stepActive : styles.stepPending}`}>
              <div className={styles.stepDot}>
                {i < activeStep ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                ) : (
                  <span className={styles.stepNumber}>{i + 1}</span>
                )}
              </div>
              <span className={styles.stepLabel}>{step.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
