import { useState, useEffect, useCallback } from 'react'
import { useParams, useOutletContext } from 'react-router-dom'
import {
  Button,
  Badge,
  Spinner,
  StatusIndicator,
  MarkdownRenderer,
  EmptyState,
} from '../../../design-system/components/index.js'
import { api, type DocPageDTO, type GeneratedDocDTO, type ProjectDTO, type RunDTO, type StepEventDTO } from '../../../shared/api/client.js'

interface PageContext {
  project: ProjectDTO
  pages: DocPageDTO[]
  refetchPages: () => Promise<void>
}

interface LiveStep {
  type: string
  action: string
  stepIndex: number
}

export function PageView(): React.ReactElement {
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>()
  const context = useOutletContext<PageContext>()
  const [page, setPage] = useState<DocPageDTO | null>(null)
  const [doc, setDoc] = useState<GeneratedDocDTO | null>(null)
  const [latestRun, setLatestRun] = useState<RunDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [exploring, setExploring] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([])
  const [liveUrl, setLiveUrl] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    if (!projectId || !pageId) return
    try {
      const [pageData, docData, runData] = await Promise.all([
        api.pages.get(projectId, pageId),
        api.pages.doc(projectId, pageId).catch(() => null),
        api.pages.latestRun(projectId, pageId),
      ])
      setPage(pageData)
      setDoc(docData)
      setLatestRun(runData)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [projectId, pageId])

  useEffect(() => {
    setLoading(true)
    setDoc(null)
    setError(null)
    setLiveSteps([])
    setLiveUrl(null)
    setExploring(false)
    setStatusMessage(null)
    void fetchData()
  }, [fetchData])

  const runExploration = async (runId: string): Promise<void> => {
    setExploring(true)
    setError(null)
    setLiveSteps([])
    setLiveUrl(null)
    setStatusMessage('Launching browser...')

    try {
      await api.runs.exploreStream(
        runId,
        (event: StepEventDTO) => {
          switch (event.type) {
            case 'live': setLiveUrl(event.liveUrl ?? null); break
            case 'status': setStatusMessage(event.message ?? null); break
            case 'step':
              if (event.step) {
                setLiveSteps((prev) => [...prev, {
                  type: event.step!.type,
                  action: event.step!.action ?? event.step!.type,
                  stepIndex: event.stepIndex ?? prev.length,
                }])
                setStatusMessage(event.message ?? null)
              }
              break
            case 'done': setStatusMessage(event.message ?? 'Exploration complete'); break
            case 'blocked': setStatusMessage(event.message ?? 'Agent needs help'); break
            case 'error': setStatusMessage(event.message ?? 'Error'); break
          }
        },
      )

      // Stream ended — generate doc from whatever we have
      setLiveUrl(null)
      const updatedRun = await api.runs.get(runId)

      if (updatedRun.status !== 'pending' && updatedRun.status !== 'running') {
        setStatusMessage('Generating documentation...')
        setGenerating(true)

        try {
          await api.runs.generateDoc(runId)
          await api.pages.update(projectId!, pageId!, { status: 'published' })
        } catch {
          // partial doc or no doc — ok
        }

        if (updatedRun.status === 'blocked') {
          setStatusMessage('Exploration paused — you can continue anytime')
        } else if (updatedRun.status === 'failed') {
          setStatusMessage('Exploration stopped — partial doc generated')
        } else {
          setStatusMessage(null)
        }
      }

      await fetchData()
      await context.refetchPages()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setExploring(false)
      setGenerating(false)
    }
  }

  const handleNewExploration = async (): Promise<void> => {
    if (!projectId || !pageId || !page) return
    const startUrl = page.startUrl ?? context.project.baseUrl
    const run = await api.runs.create({
      featureName: page.title,
      startUrl,
      goal: page.goal ?? `Document the "${page.title}" feature`,
      docPageId: pageId,
    })
    await api.pages.update(projectId, pageId, { status: 'exploring' })
    await runExploration(run.id)
  }

  const handleContinueExploration = async (): Promise<void> => {
    if (!latestRun || !projectId || !pageId) return
    // Reset the run to a continuable state
    await api.pages.update(projectId, pageId, { status: 'exploring' })
    await runExploration(latestRun.id)
  }

  if (loading) return <Spinner size="lg" />
  if (!page) return <EmptyState title="Page not found" />

  const statusMap: Record<string, 'pending' | 'running' | 'completed'> = {
    draft: 'pending',
    exploring: 'running',
    published: 'completed',
  }

  const canContinue = latestRun &&
    (latestRun.status === 'blocked' || latestRun.status === 'failed') &&
    !exploring && !generating

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, flex: 1 }}>{page.title}</h1>
        <StatusIndicator status={statusMap[page.status] ?? 'pending'} label={page.status} />
      </div>

      {page.goal && (
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', marginBottom: 'var(--space-sm)' }}>
          {page.goal}
        </p>
      )}

      {page.startUrl && <Badge color="blue">{page.startUrl}</Badge>}

      {/* Status message */}
      {statusMessage && !exploring && !generating && (
        <p style={{
          color: 'var(--color-accent-amber)', fontSize: 'var(--text-sm)',
          margin: 'var(--space-md) 0', padding: 'var(--space-sm) var(--space-md)',
          backgroundColor: 'rgba(245,166,35,0.1)', borderRadius: 'var(--radius-md)',
          border: '1px solid rgba(245,166,35,0.2)',
        }}>
          {statusMessage}
        </p>
      )}

      {/* Action buttons */}
      {!exploring && !generating && (
        <div style={{ display: 'flex', gap: 'var(--space-sm)', margin: 'var(--space-lg) 0', flexWrap: 'wrap' }}>
          {canContinue && (
            <Button onClick={() => void handleContinueExploration()}>
              Continue Exploration
            </Button>
          )}
          <Button
            variant={canContinue ? 'secondary' : 'primary'}
            onClick={() => void handleNewExploration()}
          >
            {doc ? 'Re-explore from scratch' : canContinue ? 'Start fresh' : 'Explore & Document'}
          </Button>
        </div>
      )}

      {/* Live exploration feed */}
      {(exploring || generating) && (
        <div style={{ margin: 'var(--space-lg) 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
            <Spinner size="sm" />
            <span style={{ color: generating ? 'var(--color-accent-green)' : 'var(--color-accent-blue)', fontSize: 'var(--text-sm)' }}>
              {statusMessage}
            </span>
          </div>

          {liveUrl && (
            <div style={{
              marginBottom: 'var(--space-md)', borderRadius: 'var(--radius-lg)',
              overflow: 'hidden', border: '1px solid var(--color-border-default)',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
                padding: 'var(--space-xs) var(--space-md)',
                backgroundColor: 'var(--color-bg-surface)', borderBottom: '1px solid var(--color-border-subtle)',
              }}>
                <span style={{ width: '8px', height: '8px', borderRadius: 'var(--radius-full)', backgroundColor: 'var(--color-accent-green)', animation: 'pulse 2s infinite' }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Live browser</span>
              </div>
              <iframe src={liveUrl} title="Live browser" style={{ width: '100%', height: '400px', border: 'none', display: 'block' }} />
            </div>
          )}

          {liveSteps.length > 0 && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: '1px',
              backgroundColor: 'var(--color-border-subtle)', borderRadius: 'var(--radius-lg)',
              overflow: 'hidden', maxHeight: '250px', overflowY: 'auto',
            }}>
              {liveSteps.map((ls, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-md)',
                  padding: 'var(--space-xs) var(--space-md)',
                  backgroundColor: 'var(--color-bg-surface)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)',
                }}>
                  <span style={{ color: 'var(--color-text-muted)', minWidth: '20px' }}>{ls.stepIndex + 1}</span>
                  <span style={{ color: 'var(--color-accent-blue)', backgroundColor: 'var(--color-bg-elevated)', padding: '1px 6px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)' }}>{ls.type}</span>
                  <span style={{ color: 'var(--color-text-primary)' }}>{ls.action}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <EmptyState title="Error" description={error} />}

      {/* Generated doc */}
      {doc?.markdownContent && (
        <div style={{ marginTop: 'var(--space-lg)' }}>
          <MarkdownRenderer content={doc.markdownContent} />
        </div>
      )}

      {!doc?.markdownContent && !exploring && !generating && page.status === 'draft' && (
        <EmptyState
          title="No documentation yet"
          description="Click 'Explore & Document' to let the AI agent document this feature."
        />
      )}
    </div>
  )
}
