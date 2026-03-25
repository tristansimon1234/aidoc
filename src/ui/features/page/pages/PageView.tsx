import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import {
  Button,
  Badge,
  Spinner,
  StatusIndicator,
  MarkdownRenderer,
  EmptyState,
} from '../../../design-system/components/index.js'
import { api, type DocPageDTO, type GeneratedDocDTO } from '../../../shared/api/client.js'

export function PageView(): React.ReactElement {
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>()
  const [page, setPage] = useState<DocPageDTO | null>(null)
  const [doc, setDoc] = useState<GeneratedDocDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [exploring, setExploring] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    if (!projectId || !pageId) return
    try {
      const pageData = await api.pages.get(projectId, pageId)
      setPage(pageData)
      // Try to get doc via runs — for now just try the doc endpoint
      const docData = await api.runs.doc(pageId).catch(() => null)
      setDoc(docData)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [projectId, pageId])

  useEffect(() => { void fetchData() }, [fetchData])

  if (loading) return <Spinner size="lg" />

  if (!page) return <EmptyState title="Page not found" />

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, flex: 1 }}>{page.title}</h1>
        <StatusIndicator status={page.status as 'pending' | 'running' | 'blocked' | 'completed' | 'failed'} label={page.status} />
      </div>

      {page.goal && (
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', marginBottom: 'var(--space-md)' }}>
          {page.goal}
        </p>
      )}

      {page.startUrl && (
        <Badge color="blue">{page.startUrl}</Badge>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-sm)', margin: 'var(--space-lg) 0' }}>
        {page.status === 'draft' && (
          <Button
            disabled={exploring}
            onClick={() => {
              setExploring(true)
              setError(null)
              // Create a run for this page then explore
              const url = page.startUrl ?? ''
              api.runs
                .create({ featureName: page.title, startUrl: url, goal: page.goal ?? `Document ${page.title}` })
                .then(() => {
                  setExploring(false)
                  void fetchData()
                })
                .catch((err: Error) => { setError(err.message); setExploring(false) })
            }}
          >
            {exploring ? 'Starting...' : 'Explore This Page'}
          </Button>
        )}

        {page.status === 'published' && !doc && (
          <Button
            disabled={generating}
            onClick={() => {
              // Re-generate doc (placeholder — needs run ID)
              setGenerating(true)
            }}
          >
            {generating ? 'Generating...' : 'Re-generate Documentation'}
          </Button>
        )}
      </div>

      {error && <EmptyState title="Error" description={error} />}

      {doc?.markdownContent && (
        <div style={{ marginTop: 'var(--space-lg)' }}>
          <MarkdownRenderer content={doc.markdownContent} />
        </div>
      )}

      {!doc?.markdownContent && page.status === 'draft' && (
        <EmptyState
          title="No documentation yet"
          description="Click 'Explore This Page' to let the AI agent document this feature."
        />
      )}
    </div>
  )
}
