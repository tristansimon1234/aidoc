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
import { api, type RunDTO, type RunStepDTO, type GeneratedDocDTO, type QuestionDTO } from '../../../shared/api/client.js'
import { StepTimeline } from '../components/StepTimeline.js'
import styles from './RunDetail.module.css'

type Phase = 'loading' | 'idle' | 'exploring' | 'generating' | 'done' | 'blocked' | 'failed'

export function RunDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>()
  const [run, setRun] = useState<RunDTO | null>(null)
  const [steps, setSteps] = useState<RunStepDTO[]>([])
  const [questions, setQuestions] = useState<QuestionDTO[]>([])
  const [doc, setDoc] = useState<GeneratedDocDTO | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [message, setMessage] = useState<string | null>(null)
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
      setMessage((err as Error).message)
      setPhase('failed')
      return null
    }
  }, [id])

  // Initial fetch
  useEffect(() => {
    fetchData().then((runData) => {
      if (!runData) return
      if (runData.status === 'completed') setPhase('done')
      else if (runData.status === 'blocked') setPhase('blocked')
      else if (runData.status === 'failed') setPhase('failed')
      else setPhase('idle')
    })
  }, [fetchData])

  // Auto-start for pending runs
  useEffect(() => {
    if (!id || !run || phase !== 'idle' || run.status !== 'pending' || startedRef.current) return
    startedRef.current = true
    void launchExploration()
    // eslint-disable-next-line
  }, [id, run, phase])

  const launchExploration = async (context?: string): Promise<void> => {
    if (!id) return
    setPhase('exploring')
    setMessage('Launching browser and exploring...')

    try {
      const result = await api.runs.explore(id, context)
      await fetchData()

      if (result.needsQuestion) {
        setPhase('blocked')
        setMessage(result.question)
      } else if (result.completed) {
        // Auto-generate doc
        setPhase('generating')
        setMessage('Generating SOP documentation...')
        try {
          const docResult = await api.runs.generateDoc(id)
          setDoc(docResult)
        } catch {
          // ok, user can retry later
        }
        await fetchData()
        setPhase('done')
        setMessage('Exploration and documentation complete.')
      } else {
        setPhase('failed')
        setMessage(result.message || 'Exploration ended without completing.')
        await fetchData()
      }
    } catch (err) {
      setPhase('failed')
      setMessage((err as Error).message)
      await fetchData()
    }
  }

  const handleResume = (): void => {
    const context = userInput.trim()
    if (!context) return
    setUserInput('')
    void launchExploration(context)
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

      {/* Exploring */}
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

      {/* Generating doc */}
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

      {/* Blocked — show question and input for user to help */}
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
              {latestQuestion?.question ?? message}
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

      {/* Failed — show error and retry button */}
      {phase === 'failed' && (
        <div className={styles.section}>
          <EmptyState
            title="Exploration failed"
            description={message ?? 'Something went wrong.'}
            action={<Button onClick={handleRetry}>Retry</Button>}
          />
        </div>
      )}

      {/* Done */}
      {phase === 'done' && !doc && (
        <div className={styles.section}>
          <Button onClick={() => {
            if (!id) return
            setPhase('generating')
            setMessage('Generating SOP documentation...')
            api.runs.generateDoc(id)
              .then((d) => { setDoc(d); setPhase('done') })
              .catch((err: Error) => { setPhase('failed'); setMessage(err.message) })
          }}>
            Generate Documentation
          </Button>
        </div>
      )}

      {/* Steps */}
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
