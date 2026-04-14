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
  /** When true, plays the exit animation then calls onExited */
  done?: boolean
  onExited?: () => void
}

export function ProgressLoader({ steps, activeStep, statusMessage, done, onExited }: ProgressLoaderProps): React.ReactElement | null {
  const [elapsed, setElapsed] = useState(0)
  const [exiting, setExiting] = useState(false)
  const [hidden, setHidden] = useState(false)
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

  // Handle done → exit animation → hide
  useEffect(() => {
    if (!done) return
    setExiting(true)
    const timer = setTimeout(() => {
      setHidden(true)
      onExited?.()
    }, 600)
    return () => clearTimeout(timer)
  }, [done, onExited])

  if (hidden) return null

  const totalEstimated = steps.reduce((sum, s) => sum + s.estimatedSeconds, 0)
  const completedTime = steps.slice(0, activeStep).reduce((sum, s) => sum + s.estimatedSeconds, 0)
  const currentEstimated = steps[activeStep]?.estimatedSeconds ?? 10

  const raw = Math.min(elapsed / currentEstimated, 0.95)
  const eased = 1 - Math.pow(1 - raw, 3)
  const overall = done ? 1 : Math.min((completedTime + eased * currentEstimated) / totalEstimated, 0.98)
  const percent = Math.round(overall * 100)
  const isLight = percent > 45

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
    <div className={`${styles.container} ${exiting ? styles.containerExit : ''}`}>
      <div className={styles.water} style={{ height: `${Math.max(3, percent)}%` }}>
        <svg className={styles.waveSvg} viewBox="0 0 1200 20" preserveAspectRatio="none">
          <path className={styles.wavePath1}
            d="M0,10 C100,18 300,2 500,10 C700,18 900,2 1100,10 L1200,10 L1200,20 L0,20 Z" />
          <path className={styles.wavePath2}
            d="M0,13 C150,6 350,17 600,11 C850,5 1050,17 1200,13 L1200,20 L0,20 Z" />
        </svg>
        <svg className={styles.waveSvg2} viewBox="0 0 1200 16" preserveAspectRatio="none">
          <path className={styles.wavePath3}
            d="M0,8 C200,14 400,3 600,9 C800,15 1000,3 1200,8 L1200,16 L0,16 Z" />
        </svg>
      </div>

      <div className={`${styles.content} ${isLight ? styles.contentLight : ''}`}>
        <div className={styles.percentBlock}>
          <span className={styles.percent}>{percent}</span>
          <span className={styles.percentSign}>%</span>
        </div>
        <div className={styles.info}>
          <span className={styles.status}>
            {done ? 'Done!' : (statusMessage ?? steps[activeStep]?.label ?? 'Processing...')}
          </span>
          {!done && <span className={styles.time}>{fmt(remaining)}</span>}
        </div>
        {steps.length > 1 && (
          <div className={styles.steps}>
            {steps.map((_, i) => (
              <div key={i} className={`${styles.dot} ${
                done || i < activeStep ? styles.dotDone :
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
