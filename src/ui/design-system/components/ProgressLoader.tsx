import { useState, useEffect, useRef } from 'react'
import styles from './ProgressLoader.module.css'

interface ProgressStep {
  label: string
  estimatedSeconds: number
}

interface ProgressLoaderProps {
  steps: ProgressStep[]
  activeStep: number
  statusMessage?: string | null
}

export function ProgressLoader({ steps, activeStep, statusMessage }: ProgressLoaderProps): React.ReactElement {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(Date.now())

  useEffect(() => {
    startRef.current = Date.now()
    setElapsed(0)
  }, [activeStep])

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed((Date.now() - startRef.current) / 1000)
    }, 200)
    return () => clearInterval(interval)
  }, [activeStep])

  const totalEstimated = steps.reduce((sum, s) => sum + s.estimatedSeconds, 0)
  const completedTime = steps.slice(0, activeStep).reduce((sum, s) => sum + s.estimatedSeconds, 0)
  const currentStep = steps[activeStep]
  const currentEstimated = currentStep?.estimatedSeconds ?? 10

  const rawProgress = Math.min(elapsed / currentEstimated, 0.95)
  const eased = 1 - Math.pow(1 - rawProgress, 3)

  const overall = Math.min(
    (completedTime + eased * currentEstimated) / totalEstimated,
    0.98,
  )

  const percent = Math.round(overall * 100)
  const waterHeight = Math.max(2, percent)

  const remainingCurrent = Math.max(0, currentEstimated - elapsed)
  const remainingFuture = steps.slice(activeStep + 1).reduce((sum, s) => sum + s.estimatedSeconds, 0)
  const totalRemaining = Math.ceil(remainingCurrent + remainingFuture)

  const fmt = (secs: number): string => {
    if (secs <= 0) return 'almost done...'
    if (secs < 60) return `~${secs}s`
    return `~${Math.floor(secs / 60)}m ${secs % 60}s`
  }

  return (
    <div className={styles.container}>
      {/* Water rising from bottom */}
      <div className={styles.water} style={{ height: `${waterHeight}%` }}>
        {/* SVG wave at the surface */}
        <svg className={styles.waveSvg} viewBox="0 0 1200 24" preserveAspectRatio="none">
          <path className={styles.wavePath1}
            d="M0,12 C150,24 350,0 600,12 C850,24 1050,0 1200,12 L1200,24 L0,24 Z" />
          <path className={styles.wavePath2}
            d="M0,16 C200,8 400,20 600,14 C800,8 1000,22 1200,16 L1200,24 L0,24 Z" />
        </svg>
      </div>

      {/* Content on top */}
      <div className={styles.content}>
        <span className={styles.percent}>{percent}%</span>
        <span className={styles.status}>
          {statusMessage ?? currentStep?.label ?? 'Processing...'}
        </span>
        <span className={styles.time}>{fmt(totalRemaining)}</span>

        {steps.length > 1 && (
          <div className={styles.steps}>
            {steps.map((_, i) => (
              <div key={i} className={`${styles.dot} ${
                i < activeStep ? styles.dotDone :
                i === activeStep ? styles.dotActive :
                styles.dotPending
              }`} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
