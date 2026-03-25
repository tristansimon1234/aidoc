import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Badge, Spinner, StatusIndicator, CodeBlock, EmptyState } from '../../../design-system/components/index.js'
import { api, type RunDTO, type RunStepDTO, type GeneratedDocDTO } from '../../../shared/api/client.js'
import { StepTimeline } from '../components/StepTimeline.js'
import styles from './RunDetail.module.css'

export function RunDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>()
  const [run, setRun] = useState<RunDTO | null>(null)
  const [steps, setSteps] = useState<RunStepDTO[]>([])
  const [doc, setDoc] = useState<GeneratedDocDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [exploring, setExploring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef(false)

  const fetchRunData = useCallback(async () => {
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
        setDoc(docData)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [id])

  // Initial data fetch
  useEffect(() => {
    void fetchRunData()
  }, [fetchRunData])

  // Auto-start exploration loop when run is pending/running
  useEffect(() => {
    if (!run || !id) return
    if (run.status !== 'pending' && run.status !== 'running') return
    if (exploring) return

    abortRef.current = false
    setExploring(true)

    const runStepLoop = async (): Promise<void> => {
      while (!abortRef.current) {
        try {
          const result = await api.runs.step(id)

          // Refresh data after each step
          await fetchRunData()

          if (result.done) {
            setExploring(false)
            return
          }
        } catch (err) {
          setError((err as Error).message)
          setExploring(false)
          await fetchRunData()
          return
        }
      }
    }

    void runStepLoop()

    return () => {
      abortRef.current = true
    }
  }, [run?.status, id, exploring, fetchRunData])

  if (loading) {
    return (
      <Shell>
        <Spinner size="lg" />
      </Shell>
    )
  }

  if (!run) {
    return (
      <Shell>
        <EmptyState title="Run not found" description={error ?? undefined} />
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

      {exploring && (
        <div className={styles.section}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Spinner size="sm" />
            <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
              Exploring {run.startUrl}... (step {steps.length + 1})
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className={styles.section}>
          <EmptyState title="Error" description={error} />
        </div>
      )}

      {steps.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Steps</h2>
          <StepTimeline steps={steps} />
        </section>
      )}

      {doc?.markdownContent && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Generated Documentation</h2>
          <CodeBlock code={doc.markdownContent} language="markdown" />
        </section>
      )}
    </Shell>
  )
}
