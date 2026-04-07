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
import { fetchPageFull, updatePage as dbUpdatePage, createPage as dbCreatePage } from '../../../shared/api/db.js'
import { supabase } from '../../../shared/api/supabase.js'
import { ExplorationAssistant } from '../components/ExplorationAssistant.js'
import styles from './PageView.module.css'

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
  const [activeTab, setActiveTab] = useState<'doc' | 'exploration'>('doc')

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
        void dbUpdatePage(projectId, pageId, { content: docData.markdownContent })
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
          await dbUpdatePage(projectId!, pageId!, { status: 'draft' })
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
          await dbUpdatePage(projectId!, pageId!, { status: 'published' })
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
    await dbUpdatePage(projectId, pageId, { status: 'exploring' })
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
        void dbUpdatePage(projectId, pageId, pendingUpdatesRef.current)
        pendingUpdatesRef.current = null
      }
    }, 1000)
  }, [projectId, pageId])

  // Flush pending updates when navigating away or changing page
  useEffect(() => {
    return () => {
      if (pageUpdateTimeoutRef.current) clearTimeout(pageUpdateTimeoutRef.current)
      if (pendingUpdatesRef.current && projectId && pageId) {
        void dbUpdatePage(projectId, pageId, pendingUpdatesRef.current)
        pendingUpdatesRef.current = null
      }
    }
  }, [projectId, pageId])

  // Auto-switch to exploration tab when agent is active
  useEffect(() => {
    if (exploring || generating) setActiveTab('exploration')
  }, [exploring, generating])

  const handleSaveContent = async (markdown: string): Promise<void> => {
    if (!projectId || !pageId) return
    await dbUpdatePage(projectId, pageId, { content: markdown })
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
      {/* Header — status + tab bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginBottom: 'var(--space-sm)' }}>
        <StatusIndicator status={statusMap[page.status] ?? 'pending'} label={page.status} />
        {page.startUrl && <Badge color="blue">{page.startUrl}</Badge>}
      </div>

      <div className={styles.tabBar}>
        <button
          className={`${styles.tab} ${activeTab === 'doc' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('doc')}
        >
          Documentation
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'exploration' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('exploration')}
        >
          Exploration
          {(exploring || generating) && <Spinner size="sm" />}
        </button>
      </div>

      {/* ===== DOCUMENTATION TAB ===== */}
      {activeTab === 'doc' && (
        <div className={styles.tabContent}>
          <input
            className={styles.pageTitle}
            type="text"
            value={page.title}
            onChange={(e) => {
              setPage({ ...page, title: e.target.value })
              void debouncedPageUpdate({ title: e.target.value })
            }}
          />
          <BlockEditor
            key={`${pageId}-${page.content ? 'has-content' : 'empty'}-${doc?.id ?? 'no-doc'}`}
            content={page.content ?? ''}
            onSave={handleSaveContent}
          />
        </div>
      )}

      {/* ===== EXPLORATION TAB ===== */}
      {activeTab === 'exploration' && (
        <div className={styles.tabContent}>

          {/* Briefing config */}
          <div className={styles.section}>
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', margin: '0 0 var(--space-md)', lineHeight: 1.5 }}>
              Brief the agent before exploring. The more precise your briefing, the better the documentation — and the less you'll need to re-run.
            </p>
            <input
              type="text"
              value={page.goal ?? ''}
              onChange={(e) => {
                setPage({ ...page, goal: e.target.value })
                void debouncedPageUpdate({ goal: e.target.value })
              }}
              placeholder="Goal: what should this page document?"
              style={{
                background: 'none', border: 'none', outline: 'none', width: '100%',
                fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)',
                fontFamily: 'var(--font-sans)', marginBottom: 'var(--space-sm)',
              }}
            />
            <input
              type="text"
              value={page.startUrl ?? ''}
              onChange={(e) => {
                setPage({ ...page, startUrl: e.target.value })
                void debouncedPageUpdate({ startUrl: e.target.value })
              }}
              placeholder="Start URL (e.g. /pricing)"
              style={{
                background: 'none', border: 'none', outline: 'none', width: '100%',
                fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-muted)', marginBottom: 'var(--space-sm)',
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

          {/* Action button */}
          {!exploring && !generating && (
            <div className={styles.actions}>
              <Button
                variant={page.briefing?.objective ? undefined : 'secondary'}
                onClick={() => void handleNewExploration()}
              >
                {latestRun ? 'Re-explore' : 'Explore & Document'}
              </Button>
              {!page.briefing?.objective && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  Add an objective for better results
                </span>
              )}
            </div>
          )}

          {/* Live exploration feed */}
          {(exploring || generating) && (
            <div className={styles.section}>
              <div className={styles.liveFeedHeader}>
                <Spinner size="sm" />
                <span className={styles.liveFeedStatus} style={{ color: generating ? 'var(--color-accent-green)' : 'var(--color-accent-blue)' }}>
                  {statusMessage}
                </span>
                {exploring && !generating && (
                  <Button size="sm" variant="ghost" onClick={() => void handleCancel()}>Stop</Button>
                )}
              </div>

              {liveUrl && (
                <div className={styles.replayContainer} style={{ marginBottom: 'var(--space-md)' }}>
                  <div className={styles.replayHeader}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: 'var(--radius-full)', backgroundColor: 'var(--color-accent-green)', animation: 'pulse 2s infinite' }} />
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>live</span>
                    </span>
                  </div>
                  <iframe src={liveUrl} title="Live browser" className={styles.replayIframe} />
                </div>
              )}

              {liveSteps.length > 0 && (
                <div className={styles.stepsLog}>
                  {liveSteps.map((ls, i) => (
                    <div key={i} className={styles.stepRow}>
                      <span className={styles.stepIndex}>{ls.stepIndex + 1}</span>
                      <span className={styles.stepAction}>{ls.action}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Exploration Assistant — post-exploration */}
          {!exploring && !generating && latestRun && (
            <ExplorationAssistant
              run={latestRun}
              onContinue={async (ctx) => {
                if (!latestRun || !projectId || !pageId) return
                await dbUpdatePage(projectId, pageId, { status: 'exploring' })
                await runExploration(latestRun.id, ctx)
              }}
              onSkipAndGenerate={async () => {
                if (!latestRun) return
                try {
                  const generatedDoc = await api.runs.generateDoc(latestRun.id)
                  setDoc(generatedDoc)
                  if (projectId && pageId) await dbUpdatePage(projectId, pageId, { status: 'published' })
                  await fetchData()
                  await context.refetchPages()
                } catch (err) {
                  setError((err as Error).message)
                }
              }}
              onReExplore={() => handleNewExploration()}
            />
          )}

          {/* Session replay — always available after exploration */}
          {!exploring && latestRun && (
            <SessionReplay runId={latestRun.id} />
          )}

          {/* Suggestions */}
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

          {error && <EmptyState title="Error" description={error} />}
        </div>
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
  const [showExample, setShowExample] = useState(false)

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
      setUploadError(`Unsupported file type. Accepted: ${ALLOWED_FILE_EXTENSIONS.join(', ')}`)
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setUploadError('File too large (max 500KB)')
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
    color: 'var(--color-text-muted)', margin: 0,
  }

  const helpStyle: React.CSSProperties = {
    fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)',
    margin: '2px 0 var(--space-xs)', lineHeight: 1.4,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
          <p style={labelStyle}>objective</p>
          <button
            type="button"
            onClick={() => setShowExample(!showExample)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 'var(--text-xs)', color: 'var(--color-accent-blue)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {showExample ? 'hide' : 'see example'}
          </button>
        </div>
        <p style={helpStyle}>
          What should the user learn from this page? Be specific — &quot;Document the checkout flow step by step&quot; works better than &quot;Document checkout&quot;.
        </p>
        {showExample && (
          <div style={{
            fontSize: 'var(--text-xs)', lineHeight: 1.5,
            padding: 'var(--space-sm)', marginBottom: 'var(--space-xs)',
            backgroundColor: 'var(--color-bg-elevated)', borderRadius: 'var(--radius-md)',
          }}>
            <p style={{ color: 'var(--color-accent-red)', margin: '0 0 4px' }}>
              Bad: &quot;Document pricing&quot;
            </p>
            <p style={{ color: 'var(--color-accent-green)', margin: 0 }}>
              Good: &quot;Document the pricing page: compare plans, show the upgrade flow from free to pro, and explain what happens when the trial expires&quot;
            </p>
          </div>
        )}
        <textarea
          value={briefing.objective}
          onChange={(e) => update({ objective: e.target.value })}
          placeholder="e.g. Document how a new user creates an account, verifies their email, and completes onboarding"
          rows={2}
          style={fieldStyle}
        />
      </div>
      <div>
        <p style={labelStyle}>knowledge</p>
        <p style={helpStyle}>
          What can&apos;t the agent figure out by looking at the UI? Business rules, edge cases, hidden behaviors.
        </p>
        <textarea
          value={briefing.knowledge}
          onChange={(e) => update({ knowledge: e.target.value })}
          placeholder="e.g. Free trial users can't access the billing page. The 'Export' button only appears after 3 entries are created."
          rows={2}
          style={fieldStyle}
        />
      </div>
      <div>
        <p style={helpStyle}>
          Files the agent can upload into the app, or reference links. Add credentials at the project level in Settings.
        </p>
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

// --- Session Replay ---

function SessionReplay({ runId }: { runId: string }): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false

    const loadRecording = async (): Promise<void> => {
      try {
        // Get public URL for the recording
        const { data } = supabase.storage.from('artifacts').getPublicUrl(`runs/${runId}/recording.json`)
        if (!data.publicUrl) { setStatus('empty'); return }

        const res = await fetch(data.publicUrl)
        if (!res.ok) { setStatus('empty'); return }

        const events = await res.json() as unknown[]
        if (cancelled || !containerRef.current || events.length === 0) { setStatus('empty'); return }

        // Dynamic import to avoid bundling rrweb for all pages
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rrweb = await import('rrweb') as any
        containerRef.current.innerHTML = ''
        new rrweb.Replayer(events, {
          root: containerRef.current,
          skipInactive: true,
          showWarning: false,
          showDebug: false,
          blockClass: 'rr-block',
          speed: 1,
        })
        setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      }
    }

    void loadRecording()
    return () => { cancelled = true }
  }, [runId])

  if (status === 'empty') return <></>

  return (
    <div className={styles.section}>
      <p style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)', margin: '0 0 var(--space-sm)' }}>
        session replay
      </p>
      {status === 'loading' && <Spinner size="sm" />}
      {status === 'error' && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Recording unavailable</span>}
      <div ref={containerRef} className={styles.replayContainer} />
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
      const newPage = await dbCreatePage(projectId, {
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
