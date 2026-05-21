import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './Button.js'
import styles from './StepperFlow.module.css'

export interface StepperStep<S> {
  /** Short label shown in the top progress bar. */
  title: string
  /** "AI message" displayed in a chat bubble at the top of the step. */
  message: string
  /** Form / input content for this step. Receives current state + setter. */
  render: (state: S, setState: (patch: Partial<S>) => void) => React.ReactNode
  /** Optional: gate the Continue button. Return true when the step is valid. */
  validate?: (state: S) => boolean
  /** Optional hint shown next to a disabled Continue button. */
  hint?: (state: S) => string | null
}

interface StepperFlowProps<S> {
  steps: StepperStep<S>[]
  initialState: S
  /** Called when the user clicks Finish on the last step. */
  onComplete: (state: S) => void | Promise<void>
  /** Optional cancel handler — renders a "Cancel" ghost button on step 0. */
  onCancel?: () => void
  /** Label of the final CTA. Defaults to "Generate". */
  finishLabel?: string
  /** Disable navigation while a submit is in flight. */
  submitting?: boolean
}

export function StepperFlow<S>({
  steps,
  initialState,
  onComplete,
  onCancel,
  finishLabel = 'Generate',
  submitting = false,
}: StepperFlowProps<S>): React.ReactElement {
  const [index, setIndex] = useState(0)
  const [state, setState] = useState<S>(initialState)
  // Typing effect: reveal the AI message character-by-character on step change.
  const [revealed, setRevealed] = useState('')
  const messageRef = useRef('')

  const current = steps[index]!
  const isLast = index === steps.length - 1
  const isFirst = index === 0

  useEffect(() => {
    messageRef.current = current.message
    setRevealed('')
    let i = 0
    const id = window.setInterval(() => {
      if (messageRef.current !== current.message) {
        window.clearInterval(id)
        return
      }
      i += 2
      setRevealed(current.message.slice(0, i))
      if (i >= current.message.length) {
        setRevealed(current.message)
        window.clearInterval(id)
      }
    }, 16)
    return () => window.clearInterval(id)
  }, [current.message])

  const patch = useMemo(
    () => (delta: Partial<S>) => setState((prev) => ({ ...prev, ...delta })),
    [],
  )

  const valid = current.validate ? current.validate(state) : true
  const hint = !valid && current.hint ? current.hint(state) : null

  const handleNext = (): void => {
    if (!valid || submitting) return
    if (isLast) {
      void onComplete(state)
      return
    }
    setIndex(index + 1)
  }

  const handleBack = (): void => {
    if (isFirst) {
      onCancel?.()
      return
    }
    setIndex(index - 1)
  }

  return (
    <div className={styles.root}>
      {/* Top progress bar */}
      <div className={styles.progress} role="tablist" aria-label="Step progress">
        {steps.map((step, i) => {
          const done = i < index
          const active = i === index
          return (
            <div key={step.title} className={styles.progressItem}>
              <div className={`${styles.dot} ${done ? styles.dotDone : active ? styles.dotActive : styles.dotPending}`}>
                {done ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <span className={styles.dotNumber}>{i + 1}</span>
                )}
              </div>
              <span className={`${styles.label} ${active ? styles.labelActive : ''}`}>{step.title}</span>
              {i < steps.length - 1 && <div className={`${styles.connector} ${done ? styles.connectorDone : ''}`} />}
            </div>
          )
        })}
      </div>

      {/* AI bubble */}
      <div className={styles.bubble}>
        <div className={styles.avatar} aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v4" /><path d="M5 8a7 7 0 0 1 14 0v4a7 7 0 0 1-14 0z" />
            <path d="M9 12h.01" /><path d="M15 12h.01" /><path d="M10 16h4" />
          </svg>
        </div>
        <div className={styles.bubbleBody}>
          <span className={styles.bubbleText}>{revealed}</span>
          {revealed.length < current.message.length && <span className={styles.cursor} />}
        </div>
      </div>

      {/* Step body */}
      <div className={styles.body}>{current.render(state, patch)}</div>

      {/* Footer actions */}
      <div className={styles.footer}>
        <div className={styles.footerLeft}>
          {(!isFirst || onCancel) && (
            <Button variant="ghost" size="sm" onClick={handleBack} disabled={submitting}>
              {isFirst ? 'Cancel' : 'Back'}
            </Button>
          )}
        </div>
        <div className={styles.footerRight}>
          {hint && <span className={styles.hint}>{hint}</span>}
          <Button
            variant="primary"
            size="sm"
            onClick={handleNext}
            disabled={!valid || submitting}
          >
            {submitting ? 'Working…' : isLast ? finishLabel : 'Continue'}
          </Button>
        </div>
      </div>
    </div>
  )
}
