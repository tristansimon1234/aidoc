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
import { api, type DocPageDTO, type GeneratedDocDTO, type ProjectDTO, type StepEventDTO } from '../../../shared/api/client.js'

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
      const pageData = await api.pages.get(projectId, pageId)
      setPage(pageData)
      const docData = await api.pages.doc(projectId, pageId).catch(() => null)
      setDoc(docData)
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
    void fetchData()
  }, [fetchData])

  const handleExplore = async (): Promise<void> => {
    if (!projectId || !pageId || !page) return
    setExploring(true)
    setError(null)
    setLiveSteps([])
    setLiveUrl(null)
    setStatusMessage('Creating exploration run...')

    try {
      // Create a run linked to this page
      const startUrl = page.startUrl ?? context.project.baseUrl
      const run = await api.runs.create({
        featureName: page.title,
        startUrl,
        goal: page.goal ?? `Document the "${page.title}" feature`,
        docPageId: pageId,
      })

      // Update page status
      await api.pages.update(projectId, pageId, { status: 'exploring' })

      // Stream exploration
      setStatusMessage('Launching browser...')
      await api.runs.exploreStream(
        run.id,
        (event: StepEventDTO) => {
          switch (event.type) {
            case 'live':
              setLiveUrl(event.liveUrl ?? null)
              break
            case 'status':
              setStatusMessage(event.message ?? null)
              break
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
            case 'done':
              setStatusMessage(event.message ?? 'Exploration complete')
              break
            case 'blocked':
              setStatusMessage(event.message ?? 'Agent needs help')
              break
            case 'error':
              setStatusMessage(event.message ?? 'Error')
              break
          }
        },
      )

      // Stream ended — check if exploration actually completed
      setLiveUrl(null)
      const updatedRun = await api.runs.get(run.id)

      if (updatedRun.status === 'completed') {
        // Generate documentation
        setStatusMessage('Generating documentation...')
        setGenerating(true)

        try {
          await api.runs.generateDoc(run.id)
          await api.pages.update(projectId, pageId, { status: 'published' })
        } catch (genErr) {
          setError(`Doc generation failed: ${(genErr as Error).message}`)
        }
      } else if (updatedRun.status === 'blocked') {
        setStatusMessage('Agent was blocked. Check the run for details.')
      } else if (updatedRun.status === 'failed') {
        setError('Exploration failed. Try again.')
      }

      // Refresh
      await fetchData()
      await context.refetchPages()
      setStatusMessage(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setExploring(false)
      setGenerating(false)
    }
  }

  if (loading) return <Spinner size="lg" />
  if (!page) return <EmptyState title="Page not found" />

  const statusMap: Record<string, 'pending' | 'running' | 'completed'> = {
    draft: 'pending',
    exploring: 'running',
    published: 'completed',
  }

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

      {/* Action buttons */}
      {!exploring && !generating && (
        <div style={{ display: 'flex', gap: 'var(--space-sm)', margin: 'var(--space-lg) 0' }}>
          {(page.status === 'draft' || page.status === 'published') && (
            <Button onClick={() => void handleExplore()}>
              {page.status === 'published' ? 'Re-explore' : 'Explore & Document'}
            </Button>
          )}
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
              marginBottom: 'var(--space-md)',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
              border: '1px solid var(--color-border-default)',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
                padding: 'var(--space-xs) var(--space-md)',
                backgroundColor: 'var(--color-bg-surface)',
                borderBottom: '1px solid var(--color-border-subtle)',
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
