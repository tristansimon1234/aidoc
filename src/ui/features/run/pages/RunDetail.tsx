import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Badge, Spinner, StatusIndicator, CodeBlock, EmptyState } from '../../../design-system/components/index.js'
import { api, type RunDTO, type RunStepDTO, type GeneratedDocDTO } from '../../../shared/api/client.js'
import { StepTimeline } from '../components/StepTimeline.js'
import styles from './RunDetail.module.css'

type Phase = 'loading' | 'idle' | 'exploring' | 'generating' | 'done' | 'blocked' | 'error'

export function RunDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>()
  const [run, setRun] = useState<RunDTO | null>(null)
  const [steps, setSteps] = useState<RunStepDTO[]>([])
  const [doc, setDoc] = useState<GeneratedDocDTO | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const startedRef = useRef(false)

  const fetchData = useCallback(async () => {
    if (!id) return
    try {
      const [runData, stepsData] = await Promise.all([
        api.runs.get(id),
        api.runs.steps(id),
      ])
      setRun(runData)
      setSteps(stepsData)

      if (runData.status === 'completed') {
        const docData = await api.runs.doc(id).catch(() => null)
        if (docData) setDoc(docData)
      }

      return runData
    } catch (err) {
      setMessage((err as Error).message)
      setPhase('error')
      return null
    }
  }, [id])

  // Initial fetch
  useEffect(() => {
    fetchData().then((runData) => {
      if (!runData) return
      if (runData.status === 'completed') setPhase('done')
      else if (runData.status === 'blocked') setPhase('blocked')
      else if (runData.status === 'failed') setPhase('error')
      else setPhase('idle')
    })
  }, [fetchData])

  // Auto-start exploration for pending runs
  useEffect(() => {
    if (!id || !run || phase !== 'idle' || run.status !== 'pending' || startedRef.current) return
    startedRef.current = true

    const doExplore = async (): Promise<void> => {
      setPhase('exploring')
      setMessage('Launching browser and exploring...')

      try {
        const result = await api.runs.explore(id)

        // Refresh data
        await fetchData()

        if (result.needsQuestion) {
          setPhase('blocked')
          setMessage(result.question)
          return
        }

        if (result.completed) {
          // Auto-generate documentation
          setPhase('generating')
          setMessage('Generating SOP documentation...')

          try {
            const docResult = await api.runs.generateDoc(id)
            setDoc(docResult)
          } catch {
            // Doc generation failed but exploration succeeded
          }

          await fetchData()
          setPhase('done')
          setMessage('Exploration complete. Documentation generated.')
        } else {
          setPhase('error')
          setMessage(result.message || 'Exploration ended without completing.')
          await fetchData()
        }
      } catch (err) {
        setPhase('error')
        setMessage((err as Error).message)
        await fetchData()
      }
    }

    void doExplore()
  }, [id, run, phase, fetchData])

  if (phase === 'loading') {
    return (
      <Shell>
        <Spinner size="lg" />
      </Shell>
    )
  }

  if (!run) {
    return (
      <Shell>
        <EmptyState title="Run not found" />
      </Shell>
    )
  }

  return (
    <Shell>
      <Link to="/" className={styles.back}>
        &larr; runs
      </Link>

      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{run.featureName}</h1>
          <StatusIndicator status={run.status} />
        </div>
        <p className={styles.goal}>{run.goal}</p>
        <div className={styles.badges}>
          <Badge color="blue">{run.tokenUsage.toLocaleString()} tokens</Badge>
          <Badge color="purple">{steps.length} steps</Badge>
        </div>
      </div>

      {/* Exploring state */}
      {phase === 'exploring' && (
        <div className={styles.section}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Spinner size="sm" />
            <span style={{ color: 'var(--color-accent-blue)', fontSize: 'var(--text-sm)' }}>
              {message}
            </span>
          </div>
        </div>
      )}

      {/* Generating doc state */}
      {phase === 'generating' && (
        <div className={styles.section}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Spinner size="sm" />
            <span style={{ color: 'var(--color-accent-green)', fontSize: 'var(--text-sm)' }}>
              {message}
            </span>
          </div>
        </div>
      )}

      {/* Blocked state */}
      {phase === 'blocked' && message && (
        <div className={styles.section}>
          <EmptyState title="Blocked" description={message} />
        </div>
      )}

      {/* Error state */}
      {phase === 'error' && message && (
        <div className={styles.section}>
          <EmptyState title="Error" description={message} />
        </div>
      )}

      {/* Done message */}
      {phase === 'done' && message && (
        <div className={styles.section}>
          <p style={{ color: 'var(--color-accent-green)', fontSize: 'var(--text-sm)' }}>
            {message}
          </p>
        </div>
      )}

      {/* Generate doc button if exploration done but no doc yet */}
      {run.status === 'completed' && !doc && phase === 'done' && (
        <div className={styles.section}>
          <Button onClick={() => {
            if (!id) return
            setPhase('generating')
            setMessage('Generating SOP documentation...')
            api.runs.generateDoc(id)
              .then((d) => { setDoc(d); setPhase('done'); setMessage('Documentation generated.') })
              .catch((err: Error) => { setPhase('error'); setMessage(err.message) })
          }}>
            Generate Documentation
          </Button>
        </div>
      )}

      {/* Steps timeline */}
      {steps.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Steps ({steps.length})</h2>
          <StepTimeline steps={steps} />
        </section>
      )}

      {/* Generated doc */}
      {doc?.markdownContent && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Generated Documentation</h2>
          <CodeBlock code={doc.markdownContent} language="markdown" />
        </section>
      )}
    </Shell>
  )
}
