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
    }, 250)
    return () => clearInterval(interval)
  }, [activeStep])

  const totalEstimated = steps.reduce((sum, s) => sum + s.estimatedSeconds, 0)
  const completedTime = steps.slice(0, activeStep).reduce((sum, s) => sum + s.estimatedSeconds, 0)
  const currentEstimated = steps[activeStep]?.estimatedSeconds ?? 10

  const raw = Math.min(elapsed / currentEstimated, 0.95)
  const eased = 1 - Math.pow(1 - raw, 3)
  const overall = Math.min((completedTime + eased * currentEstimated) / totalEstimated, 0.98)
  const percent = Math.round(overall * 100)

  // Text inverts when water covers the content area (roughly > 55%)
  const isLight = percent > 55

  const remaining = Math.ceil(
    Math.max(0, currentEstimated - elapsed) +
    steps.slice(activeStep + 1).reduce((sum, s) => sum + s.estimatedSeconds, 0),
  )

  const fmt = (s: number): string => {
    if (s <= 0) return 'finishing...'
    if (s < 60) return `${s}s left`
    return `${Math.floor(s / 60)}m ${s % 60}s left`
  }

  return (
    <div className={styles.container}>
      <div className={styles.water} style={{ height: `${Math.max(2, percent)}%` }}>
        <svg className={styles.waveSvg} viewBox="0 0 1200 16" preserveAspectRatio="none">
          <path className={styles.wavePath1}
            d="M0,8 C100,16 300,0 500,8 C700,16 900,0 1100,8 L1200,8 L1200,16 L0,16 Z" />
          <path className={styles.wavePath2}
            d="M0,10 C150,4 350,14 600,9 C850,4 1050,14 1200,10 L1200,16 L0,16 Z" />
        </svg>
        <svg className={styles.waveSvg2} viewBox="0 0 1200 14" preserveAspectRatio="none">
          <path className={styles.wavePath3}
            d="M0,6 C200,12 400,2 600,7 C800,12 1000,2 1200,6 L1200,14 L0,14 Z" />
        </svg>
      </div>

      <div className={`${styles.content} ${isLight ? styles.contentLight : ''}`}>
        <div className={styles.percentBlock}>
          <span className={styles.percent}>{percent}</span>
          <span className={styles.percentSign}>%</span>
        </div>
        <div className={styles.info}>
          <span className={styles.status}>
            {statusMessage ?? steps[activeStep]?.label ?? 'Processing...'}
          </span>
          <span className={styles.time}>{fmt(remaining)}</span>
        </div>
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
