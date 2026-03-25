import { type ChangeEvent, useState, useEffect, useCallback, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import {
  Button,
  Badge,
  Spinner,
  StatusIndicator,
  CodeBlock,
  EmptyState,
  Field,
} from '../../../design-system/components/index.js'
import { api, type RunDTO, type RunStepDTO, type GeneratedDocDTO, type QuestionDTO, type StepEventDTO } from '../../../shared/api/client.js'
import { StepTimeline } from '../components/StepTimeline.js'
import styles from './RunDetail.module.css'

type Phase = 'loading' | 'idle' | 'exploring' | 'generating' | 'done' | 'blocked' | 'failed'

interface LiveStep {
  type: string
  action: string
  stepIndex: number
}

export function RunDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>()
  const [run, setRun] = useState<RunDTO | null>(null)
  const [steps, setSteps] = useState<RunStepDTO[]>([])
  const [questions, setQuestions] = useState<QuestionDTO[]>([])
  const [doc, setDoc] = useState<GeneratedDocDTO | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([])
  const [userInput, setUserInput] = useState('')
  const startedRef = useRef(false)

  const fetchData = useCallback(async () => {
    if (!id) return null
    try {
      const [runData, stepsData, questionsData] = await Promise.all([
        api.runs.get(id),
        api.runs.steps(id),
        api.runs.questions(id),
      ])
      setRun(runData)
      setSteps(stepsData)
      setQuestions(questionsData)

      if (runData.status === 'completed') {
        const docData = await api.runs.doc(id).catch(() => null)
        if (docData) setDoc(docData)
      }
      return runData
    } catch (err) {
      setStatusMessage((err as Error).message)
      setPhase('failed')
      return null
    }
  }, [id])

  useEffect(() => {
    fetchData().then((runData) => {
      if (!runData) return
      if (runData.status === 'completed') setPhase('done')
      else if (runData.status === 'blocked') setPhase('blocked')
      else if (runData.status === 'failed') setPhase('failed')
      else setPhase('idle')
    })
  }, [fetchData])

  // Auto-start pending runs
  useEffect(() => {
    if (!id || !run || phase !== 'idle' || run.status !== 'pending' || startedRef.current) return
    startedRef.current = true
    void launchExploration()
    // eslint-disable-next-line
  }, [id, run, phase])

  const launchExploration = async (context?: string): Promise<void> => {
    if (!id) return
    setPhase('exploring')
    setStatusMessage('Launching browser...')
    setLiveSteps([])

    try {
      await api.runs.exploreStream(
        id,
        (event: StepEventDTO) => {
          switch (event.type) {
            case 'status':
              setStatusMessage(event.message ?? null)
              break
            case 'step':
              if (event.step) {
                setLiveSteps((prev) => [
                  ...prev,
                  {
                    type: event.step!.type,
                    action: event.step!.action ?? event.step!.type,
                    stepIndex: event.stepIndex ?? prev.length,
                  },
                ])
                setStatusMessage(event.message ?? null)
              }
              break
            case 'done':
              setStatusMessage(event.message ?? 'Exploration complete')
              break
            case 'blocked':
              setStatusMessage(event.message ?? 'Agent needs help')
              break
            case 'error':
              setStatusMessage(event.message ?? 'Something went wrong')
              break
          }
        },
        context,
      )

      // Stream ended — fetch final state
      const runData = await fetchData()
      if (!runData) return

      if (runData.status === 'completed') {
        setPhase('generating')
        setStatusMessage('Generating SOP documentation...')
        try {
          const docResult = await api.runs.generateDoc(id)
          setDoc(docResult)
        } catch {
          // doc gen failed, user can retry
        }
        await fetchData()
        setPhase('done')
        setStatusMessage('Done')
      } else if (runData.status === 'blocked') {
        setPhase('blocked')
      } else if (runData.status === 'failed') {
        setPhase('failed')
      } else {
        setPhase('done')
      }
    } catch (err) {
      setPhase('failed')
      setStatusMessage((err as Error).message)
      await fetchData()
    }
  }

  const handleResume = (): void => {
    const ctx = userInput.trim()
    if (!ctx) return
    setUserInput('')
    void launchExploration(ctx)
  }

  const handleRetry = (): void => {
    void launchExploration()
  }

  if (phase === 'loading') {
    return <Shell><Spinner size="lg" /></Shell>
  }

  if (!run) {
    return <Shell><EmptyState title="Run not found" /></Shell>
  }

  const latestQuestion = questions.filter((q) => !q.answer).at(-1)

  return (
    <Shell>
      <Link to="/" className={styles.back}>&larr; runs</Link>

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

      {/* Live exploration feed */}
      {phase === 'exploring' && (
        <div className={styles.section}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
            <Spinner size="sm" />
            <span style={{ color: 'var(--color-accent-blue)', fontSize: 'var(--text-sm)' }}>
              {statusMessage}
            </span>
          </div>
          {liveSteps.length > 0 && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              backgroundColor: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border-subtle)',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
              maxHeight: '300px',
              overflowY: 'auto',
            }}>
              {liveSteps.map((ls, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-md)',
                    padding: 'var(--space-sm) var(--space-md)',
                    backgroundColor: 'var(--color-bg-surface)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-sm)',
                  }}
                >
                  <span style={{ color: 'var(--color-text-muted)', minWidth: '24px' }}>
                    {ls.stepIndex + 1}
                  </span>
                  <span style={{
                    color: 'var(--color-accent-blue)',
                    backgroundColor: 'var(--color-bg-elevated)',
                    padding: '1px 6px',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--text-xs)',
                  }}>
                    {ls.type}
                  </span>
                  <span style={{ color: 'var(--color-text-primary)' }}>
                    {ls.action}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Generating doc */}
      {phase === 'generating' && (
        <div className={styles.section}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Spinner size="sm" />
            <span style={{ color: 'var(--color-accent-green)', fontSize: 'var(--text-sm)' }}>
              {statusMessage}
            </span>
          </div>
        </div>
      )}

      {/* Blocked */}
      {phase === 'blocked' && (
        <div className={styles.section}>
          <div style={{
            padding: 'var(--space-lg)',
            backgroundColor: 'var(--color-bg-elevated)',
            border: '1px solid #4A2D10',
            borderRadius: 'var(--radius-lg)',
          }}>
            <p style={{ color: 'var(--color-accent-amber)', fontSize: 'var(--text-md)', fontWeight: 500, margin: '0 0 var(--space-sm)' }}>
              Agent needs help
            </p>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', margin: '0 0 var(--space-md)' }}>
              {latestQuestion?.question ?? statusMessage}
            </p>
            <Field
              label="your_response"
              multiline
              placeholder="e.g. Use test@example.com / password123, or: Skip the login and go to /dashboard"
              value={userInput}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setUserInput(e.target.value)}
              rows={3}
            />
            <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-md)' }}>
              <Button onClick={handleResume} disabled={!userInput.trim()}>
                Resume Exploration
              </Button>
              <Button variant="ghost" onClick={handleRetry}>
                Retry Without Context
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Failed */}
      {phase === 'failed' && (
        <div className={styles.section}>
          <EmptyState
            title="Exploration failed"
            description={statusMessage ?? 'Something went wrong.'}
            action={<Button onClick={handleRetry}>Retry</Button>}
          />
        </div>
      )}

      {/* Done — generate doc button if no doc yet */}
      {phase === 'done' && !doc && run.status === 'completed' && (
        <div className={styles.section}>
          <Button onClick={() => {
            if (!id) return
            setPhase('generating')
            setStatusMessage('Generating SOP documentation...')
            api.runs.generateDoc(id)
              .then((d) => { setDoc(d); setPhase('done') })
              .catch((err: Error) => { setPhase('failed'); setStatusMessage(err.message) })
          }}>
            Generate Documentation
          </Button>
        </div>
      )}

      {/* Steps from DB */}
      {steps.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Steps ({steps.length})</h2>
          <StepTimeline steps={steps} />
        </section>
      )}

      {/* Doc */}
      {doc?.markdownContent && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Generated Documentation</h2>
          <CodeBlock code={doc.markdownContent} language="markdown" />
        </section>
      )}
    </Shell>
  )
}
