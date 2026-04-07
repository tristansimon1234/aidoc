import { type ChangeEvent, useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useOutletContext, useNavigate } from 'react-router-dom'
import {
  Button,
  Badge,
  Spinner,
  StatusIndicator,
  BlockEditor,
  EmptyState,
} from '../../../design-system/components/index.js'
import { api, type DocPageDTO, type GeneratedDocDTO, type ProjectDTO, type RunDTO, type StepEventDTO, type PageBriefingDTO, type PageResourceDTO } from '../../../shared/api/client.js'
import { fetchPageFull } from '../../../shared/api/db.js'
import { supabase } from '../../../shared/api/supabase.js'
import { ExplorationAssistant } from '../components/ExplorationAssistant.js'

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
  const abortRef = useRef<AbortController | null>(null)
  const runIdRef = useRef<string | null>(null)
  const [liveUrl, setLiveUrl] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    if (!projectId || !pageId) return
    try {
      // Direct Supabase query — no Vercel cold start
      const { page: pageData, latestRun: runData, doc: docData } = await fetchPageFull(pageId)
      setPage(pageData)
      setDoc(docData)
      setLatestRun(runData)

      // If doc exists but page.content is empty, copy it over
      if (docData?.markdownContent && !pageData.content) {
        void api.pages.update(projectId, pageId, { content: docData.markdownContent })
        setPage({ ...pageData, content: docData.markdownContent })
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [projectId, pageId])

  useEffect(() => {
    setLoading(true)
    setDoc(null)
    setLatestRun(null)
    setError(null)
    setLiveSteps([])
    setLiveUrl(null)
    setExploring(false)
    setGenerating(false)
    setStatusMessage(null)
    void fetchData()
  }, [fetchData])

  const runExploration = async (runId: string, customPrompt?: string): Promise<void> => {
    setExploring(true)
    setError(null)
    setLiveSteps([])
    setLiveUrl(null)
    setStatusMessage('Launching browser...')

    const controller = new AbortController()
    abortRef.current = controller
    runIdRef.current = runId

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
            case 'cancelled': setStatusMessage('Exploration stopped'); break
            case 'error': setStatusMessage(event.message ?? 'Error'); break
          }
        },
        customPrompt,
        controller.signal,
      )

      // Stream ended — generate doc from whatever we have (skip if cancelled)
      if (controller.signal.aborted) {
        await fetchData()
        await context.refetchPages()
        return
      }

      setLiveUrl(null)
      const updatedRun = await api.runs.get(runId)

      // If Vercel killed the function mid-exploration, the run is stuck as 'running'.
      // Mark it as failed so we can still generate doc from partial data.
      if (updatedRun.status === 'running' || updatedRun.status === 'pending') {
        try {
          await api.pages.update(projectId!, pageId!, { status: 'draft' })
          await fetchData()
          await context.refetchPages()
          setStatusMessage('Exploration timed out — you can retry or generate doc from what was captured')
          return
        } catch {
          // ignore
        }
      }

      if (updatedRun.status === 'completed' || updatedRun.status === 'blocked' || updatedRun.status === 'failed') {
        setStatusMessage('Generating documentation...')
        setGenerating(true)

        try {
          const generatedDoc = await api.runs.generateDoc(runId)
          setDoc(generatedDoc)
          await api.pages.update(projectId!, pageId!, { status: 'published' })
        } catch (genErr) {
          console.error('Doc generation failed:', genErr)
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
      // AbortError is expected when user cancels — not a real error
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message)
      }
    } finally {
      abortRef.current = null
      runIdRef.current = null
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
    const customPrompt = (page as DocPageDTO & { customPrompt?: string | null }).customPrompt ?? undefined
    await runExploration(run.id, customPrompt)
  }

  const handleCancel = async (): Promise<void> => {
    if (runIdRef.current) {
      await api.runs.cancel(runIdRef.current).catch(() => {})
    }
    abortRef.current?.abort()
  }

  // Debounced page metadata update — flushes on unmount to prevent data loss
  const pageUpdateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingUpdatesRef = useRef<Record<string, unknown> | null>(null)
  const debouncedPageUpdate = useCallback((updates: Record<string, unknown>) => {
    if (!projectId || !pageId) return
    pendingUpdatesRef.current = { ...(pendingUpdatesRef.current ?? {}), ...updates }
    if (pageUpdateTimeoutRef.current) clearTimeout(pageUpdateTimeoutRef.current)
    pageUpdateTimeoutRef.current = setTimeout(() => {
      if (pendingUpdatesRef.current) {
        void api.pages.update(projectId, pageId, pendingUpdatesRef.current)
        pendingUpdatesRef.current = null
      }
    }, 1000)
  }, [projectId, pageId])

  // Flush pending updates when navigating away or changing page
  useEffect(() => {
    return () => {
      if (pageUpdateTimeoutRef.current) clearTimeout(pageUpdateTimeoutRef.current)
      if (pendingUpdatesRef.current && projectId && pageId) {
        void api.pages.update(projectId, pageId, pendingUpdatesRef.current)
        pendingUpdatesRef.current = null
      }
    }
  }, [projectId, pageId])

  const handleSaveContent = async (markdown: string): Promise<void> => {
    if (!projectId || !pageId) return
    await api.pages.update(projectId, pageId, { content: markdown })
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
      {/* Page header — editable inline */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginBottom: 'var(--space-xs)' }}>
        <StatusIndicator status={statusMap[page.status] ?? 'pending'} label={page.status} />
        {page.startUrl && <Badge color="blue">{page.startUrl}</Badge>}
      </div>

      {/* Editable page settings */}
      {!exploring && !generating && (
        <div style={{
          padding: 'var(--space-md)',
          backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 'var(--radius-lg)',
          marginBottom: 'var(--space-md)',
          display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)',
        }}>
          <input
            type="text"
            value={page.title}
            onChange={(e) => {
              setPage({ ...page, title: e.target.value })
              void debouncedPageUpdate({ title: e.target.value })
            }}
            style={{
              background: 'none', border: 'none', outline: 'none',
              fontSize: 'var(--text-xl)', fontWeight: 600,
              color: 'var(--color-text-primary)', width: '100%',
              fontFamily: 'var(--font-sans)',
            }}
          />
          <input
            type="text"
            value={page.goal ?? ''}
            onChange={(e) => {
              setPage({ ...page, goal: e.target.value })
              void debouncedPageUpdate({ goal: e.target.value })
            }}
            placeholder="Goal: what should this page document?"
            style={{
              background: 'none', border: 'none', outline: 'none',
              fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)',
              width: '100%', fontFamily: 'var(--font-sans)',
            }}
          />
          <input
            type="text"
            value={page.startUrl ?? ''}
            onChange={(e) => {
              setPage({ ...page, startUrl: e.target.value })
              void debouncedPageUpdate({ startUrl: e.target.value })
            }}
            placeholder="Start URL for exploration (e.g. /pricing)"
            style={{
              background: 'none', border: 'none', outline: 'none',
              fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
              color: 'var(--color-text-muted)', width: '100%',
            }}
          />
          <BriefingEditor
            briefing={page.briefing ?? { objective: '', knowledge: '', resources: [] }}
            pageId={pageId!}
            onChange={(briefing) => {
              setPage({ ...page, briefing })
              void debouncedPageUpdate({ briefing })
            }}
          />
        </div>
      )}

      {/* Exploration Assistant — shows after any exploration */}
      {!exploring && !generating && latestRun && (
        <ExplorationAssistant
          run={latestRun}
          onContinue={async (context) => {
            if (!latestRun || !projectId || !pageId) return
            await api.pages.update(projectId, pageId, { status: 'exploring' })
            await runExploration(latestRun.id, context)
          }}
          onSkipAndGenerate={async () => {
            if (!latestRun) return
            try {
              const generatedDoc = await api.runs.generateDoc(latestRun.id)
              setDoc(generatedDoc)
              if (projectId && pageId) await api.pages.update(projectId, pageId, { status: 'published' })
              await fetchData()
              await context.refetchPages()
            } catch (err) {
              setError((err as Error).message)
            }
          }}
          onReExplore={() => handleNewExploration()}
        />
      )}

      {/* Action buttons — only for pages that have never been explored */}
      {!exploring && !generating && !latestRun && (
        <div style={{ display: 'flex', gap: 'var(--space-sm)', margin: 'var(--space-sm) 0 var(--space-lg)', flexWrap: 'wrap' }}>
          <Button onClick={() => void handleNewExploration()}
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
            <span style={{ color: generating ? 'var(--color-accent-green)' : 'var(--color-accent-blue)', fontSize: 'var(--text-sm)', flex: 1 }}>
              {statusMessage}
            </span>
            {exploring && !generating && (
              <Button size="sm" variant="ghost" onClick={() => void handleCancel()}>
                Stop
              </Button>
            )}
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
              display: 'flex', flexDirection: 'column', gap: '2px',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden', maxHeight: '250px', overflowY: 'auto',
            }}>
              {liveSteps.map((ls, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 'var(--space-sm)',
                  padding: 'var(--space-sm) var(--space-md)',
                  backgroundColor: 'var(--color-bg-surface)',
                  fontSize: 'var(--text-sm)',
                }}>
                  <span style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', minWidth: '20px', paddingTop: '2px' }}>{ls.stepIndex + 1}</span>
                  <span style={{ color: 'var(--color-text-primary)', lineHeight: 1.4 }}>{ls.action}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <EmptyState title="Error" description={error} />}

      {/* Block Editor — always visible, always editable (like Notion) */}
      {!exploring && !generating && (
        <div style={{ marginTop: 'var(--space-lg)' }}>
          <BlockEditor
            key={`${pageId}-${page.content ? 'has-content' : 'empty'}-${doc?.id ?? 'no-doc'}`}
            content={page.content ?? ''}
            onSave={handleSaveContent}
          />
        </div>
      )}

      {/* Self-assessment + actionable suggestions */}
      {doc?.jsonContent && hasSelfAssessment(doc.jsonContent) && !exploring && !generating && (
        <SuggestionsPanel
          assessment={(doc.jsonContent as Record<string, unknown>).selfAssessment as SelfAssessment}
          projectId={projectId!}
          onPageCreated={async () => {
            await fetchData()
            await context.refetchPages()
          }}
        />
      )}

    </div>
  )
}

function hasSelfAssessment(json: Record<string, unknown>): boolean {
  return json.selfAssessment != null && typeof json.selfAssessment === 'object'
}

// --- Briefing Editor ---

const RESOURCE_TYPES: PageResourceDTO['type'][] = ['url', 'credential', 'endpoint', 'file', 'note']
const ALLOWED_FILE_EXTENSIONS = ['.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.xml']
const MAX_FILE_SIZE = 500 * 1024 // 500KB

function BriefingEditor({
  briefing,
  pageId,
  onChange,
}: {
  briefing: PageBriefingDTO
  pageId: string
  onChange: (briefing: PageBriefingDTO) => void
}): React.ReactElement {
  const [uploadError, setUploadError] = useState<string | null>(null)

  const update = (partial: Partial<PageBriefingDTO>): void => {
    onChange({ ...briefing, ...partial })
  }

  const addResource = (): void => {
    update({ resources: [...briefing.resources, { type: 'note', label: '', value: '' }] })
  }

  const updateResource = (index: number, field: keyof PageResourceDTO, value: string): void => {
    update({
      resources: briefing.resources.map((r, i) =>
        i === index ? { ...r, [field]: value } : r,
      ),
    })
  }

  const removeResource = (index: number): void => {
    update({ resources: briefing.resources.filter((_, i) => i !== index) })
  }

  const handleFileUpload = async (index: number, e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadError(null)

    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase()
    if (!ALLOWED_FILE_EXTENSIONS.includes(ext)) {
      setUploadError(`Type non supporté. Formats acceptés : ${ALLOWED_FILE_EXTENSIONS.join(', ')}`)
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setUploadError('Fichier trop volumineux (max 500KB)')
      return
    }

    const path = `pages/${pageId}/${file.name}`
    const { error } = await supabase.storage.from('briefing-files').upload(path, file, { upsert: true })
    if (error) {
      setUploadError(`Upload failed: ${error.message}`)
      return
    }

    const updated = briefing.resources.map((r, i) =>
      i === index ? { ...r, value: path, label: r.label || file.name } : r,
    )
    update({ resources: updated })
  }

  const fieldStyle: React.CSSProperties = {
    background: 'none', border: 'none', outline: 'none', resize: 'vertical',
    fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)',
    width: '100%', fontFamily: 'var(--font-sans)', minHeight: '36px',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)', marginBottom: '2px',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      <div>
        <p style={labelStyle}>objective</p>
        <textarea
          value={briefing.objective}
          onChange={(e) => update({ objective: e.target.value })}
          placeholder="Que doit documenter cette page ? Quel objectif utilisateur ?"
          rows={2}
          style={fieldStyle}
        />
      </div>
      <div>
        <p style={labelStyle}>knowledge</p>
        <textarea
          value={briefing.knowledge}
          onChange={(e) => update({ knowledge: e.target.value })}
          placeholder="Comportements non-évidents, règles métier, pièges..."
          rows={2}
          style={fieldStyle}
        />
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <p style={labelStyle}>resources</p>
          <button
            type="button"
            onClick={addResource}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            + add
          </button>
        </div>
        {uploadError && (
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-accent-red)', margin: '0 0 var(--space-xs)' }}>{uploadError}</p>
        )}
        {briefing.resources.map((r, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: 'auto 1fr 2fr auto',
            gap: 'var(--space-xs)', marginBottom: 'var(--space-xs)', alignItems: 'center',
          }}>
            <select
              value={r.type}
              onChange={(e) => updateResource(i, 'type', e.target.value)}
              style={{
                background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-sm)', padding: '4px',
                fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input
              type="text"
              value={r.label}
              onChange={(e) => updateResource(i, 'label', e.target.value)}
              placeholder="label"
              style={{ ...fieldStyle, minHeight: 'unset', padding: '4px 0' }}
            />
            {r.type === 'file' ? (
              r.value ? (
                <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', padding: '4px 0' }}>
                  {r.value.split('/').pop()}
                </span>
              ) : (
                <input
                  type="file"
                  accept={ALLOWED_FILE_EXTENSIONS.join(',')}
                  onChange={(e) => void handleFileUpload(i, e)}
                  style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', padding: '4px 0' }}
                />
              )
            ) : (
              <input
                type="text"
                value={r.value}
                onChange={(e) => updateResource(i, 'value', e.target.value)}
                placeholder="value"
                style={{ ...fieldStyle, minHeight: 'unset', padding: '4px 0' }}
              />
            )}
            <button
              type="button"
              onClick={() => removeResource(i)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)',
              }}
            >
              x
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// --- Self-Assessment + Suggestions Panel ---

interface SelfAssessment {
  overallCompleteness: number
  gaps: { area: string; reason: string; severity: string }[]
  nextSteps: { suggestion: string; reason: string; priority: string }[]
}

function getCompletenessColor(pct: number): string {
  if (pct >= 70) return 'var(--color-accent-green)'
  if (pct >= 40) return 'var(--color-accent-amber)'
  return 'var(--color-accent-red)'
}

function SuggestionsPanel({
  assessment,
  projectId,
  onPageCreated,
}: {
  assessment: SelfAssessment
  projectId: string
  onPageCreated: () => Promise<void>
}): React.ReactElement {
  const [creatingIndex, setCreatingIndex] = useState<number | null>(null)
  const navigate = useNavigate()

  const handleCreatePage = async (ns: { suggestion: string; reason: string }, index: number): Promise<void> => {
    setCreatingIndex(index)
    try {
      const slug = ns.suggestion.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
      const newPage = await api.pages.create(projectId, {
        title: ns.suggestion,
        slug: slug || `page-${Date.now()}`,
        goal: ns.reason,
      })
      await onPageCreated()
      navigate(`/projects/${projectId}/pages/${newPage.id}`)
    } catch {
      // ignore
    } finally {
      setCreatingIndex(null)
    }
  }

  const color = getCompletenessColor(assessment.overallCompleteness)

  return (
    <div style={{ marginTop: 'var(--space-xl)' }}>
      {/* Completeness bar */}
      <div style={{
        padding: 'var(--space-md)', backgroundColor: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-lg)',
        marginBottom: 'var(--space-md)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-sm)' }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>Documentation Completeness</span>
          <span style={{ fontSize: 'var(--text-md)', fontWeight: 600, fontFamily: 'var(--font-mono)', color }}>{assessment.overallCompleteness}%</span>
        </div>
        <div style={{ height: '6px', backgroundColor: 'var(--color-bg-elevated)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${assessment.overallCompleteness}%`, backgroundColor: color, borderRadius: 'var(--radius-full)', transition: 'width 0.5s ease' }} />
        </div>
      </div>

      {/* Gaps */}
      {assessment.gaps.length > 0 && (
        <div style={{
          padding: 'var(--space-md)', backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-lg)',
          marginBottom: 'var(--space-md)',
        }}>
          <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 500, marginBottom: 'var(--space-sm)', color: 'var(--color-accent-amber)' }}>
            Gaps ({assessment.gaps.length})
          </h3>
          {assessment.gaps.map((gap, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-sm)', marginBottom: 'var(--space-xs)' }}>
              <span style={{
                fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', padding: '1px 6px',
                borderRadius: 'var(--radius-sm)', flexShrink: 0,
                backgroundColor: gap.severity === 'major' ? 'rgba(255,77,77,0.15)' : 'rgba(245,166,35,0.15)',
                color: gap.severity === 'major' ? 'var(--color-accent-red)' : 'var(--color-accent-amber)',
              }}>
                {gap.severity}
              </span>
              <div>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)' }}>{gap.area}</span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginLeft: 'var(--space-sm)' }}>{gap.reason}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Suggested next pages — actionable */}
      {assessment.nextSteps.length > 0 && (
        <div style={{
          padding: 'var(--space-md)', backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-lg)',
        }}>
          <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 500, marginBottom: 'var(--space-md)', color: 'var(--color-accent-blue)' }}>
            Suggested Next Pages
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            {assessment.nextSteps.map((ns, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-md)',
                padding: 'var(--space-sm) var(--space-md)',
                backgroundColor: 'var(--color-bg-elevated)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border-subtle)',
              }}>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)', margin: 0, fontWeight: 500 }}>
                    {ns.suggestion}
                  </p>
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '2px 0 0' }}>
                    {ns.reason}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={creatingIndex === i}
                  onClick={() => void handleCreatePage(ns, i)}
                >
                  {creatingIndex === i ? '...' : 'Create Page'}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
