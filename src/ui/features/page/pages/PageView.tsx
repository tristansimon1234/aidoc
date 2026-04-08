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

interface ActivityEntry {
  text: string
  timestamp: number
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
  const [activity, setActivity] = useState<ActivityEntry[]>([])
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
    setActivity([])
    setLiveUrl(null)
    setExploring(false)
    setGenerating(false)
    setStatusMessage(null)
    void fetchData()
  }, [fetchData])

  const runExploration = async (runId: string, customPrompt?: string): Promise<void> => {
    setExploring(true)
    setError(null)
    setActivity([])
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
            case 'status':
              if (event.message && event.message.length > 15) {
                setActivity((prev) => [...prev, { text: event.message!, timestamp: Date.now() }])
              }
              setStatusMessage(event.message ?? null)
              break
            case 'step':
              if (event.message && event.message.length > 15) {
                setActivity((prev) => [...prev, { text: event.message!, timestamp: Date.now() }])
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

  const handleNewExploration = async (mode: 'complete' | 'replace' = 'replace'): Promise<void> => {
    if (!projectId || !pageId || !page) return
    const startUrl = page.startUrl ?? context.project.baseUrl
    const run = await api.runs.create({
      featureName: page.title,
      startUrl,
      goal: page.goal ?? `Document the "${page.title}" feature`,
      docPageId: pageId,
    })
    await dbUpdatePage(projectId, pageId, { status: 'exploring' })

    // In "complete" mode, pass existing doc as context so the agent fills gaps
    let exploreContext: string | undefined
    if (mode === 'complete' && page.content) {
      exploreContext = `## Existing Documentation (DO NOT repeat — focus on gaps and missing sections)\n\n${page.content.slice(0, 4000)}`
    }

    await runExploration(run.id, exploreContext)
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

          {/* Briefing config — collapsible during exploration */}
          <BriefingSection
            page={page}
            pageId={pageId!}
            briefing={page.briefing ?? { objective: '', knowledge: '', resources: [] }}
            collapsed={exploring || generating}
            onPageUpdate={(updates) => {
              setPage({ ...page, ...updates })
              void debouncedPageUpdate(updates)
            }}
            onBriefingChange={(briefing) => {
              setPage({ ...page, briefing })
              void debouncedPageUpdate({ briefing })
            }}
          />

          {/* Action button */}
          {!exploring && !generating && (
            <div className={styles.actions}>
              {latestRun && page.content ? (
                <>
                  <Button
                    variant={page.briefing?.objective ? undefined : 'secondary'}
                    onClick={() => void handleNewExploration('complete')}
                  >
                    Complete documentation
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void handleNewExploration('replace')}
                  >
                    Start from scratch
                  </Button>
                </>
              ) : (
                <Button
                  variant={page.briefing?.objective ? undefined : 'secondary'}
                  onClick={() => void handleNewExploration('replace')}
                >
                  Explore & Document
                </Button>
              )}
              {!page.briefing?.objective && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  Add an objective for better results
                </span>
              )}
            </div>
          )}

          {/* Video upload — alternative to exploration */}
          {!exploring && !generating && (
            <VideoUploader
              projectId={projectId!}
              pageId={pageId!}
              page={page}
              onComplete={async () => {
                await fetchData()
                await context.refetchPages()
                setActiveTab('doc')
              }}
            />
          )}

          {/* Live exploration feed — activity left, video right */}
          {(exploring || generating) && (
            <div>
              <div className={styles.liveFeedHeader}>
                <Spinner size="sm" />
                <span className={styles.liveFeedStatus} style={{ color: generating ? 'var(--color-accent-green)' : 'var(--color-accent-blue)' }}>
                  {statusMessage}
                </span>
                {exploring && !generating && (
                  <Button size="sm" variant="ghost" onClick={() => void handleCancel()}>Stop</Button>
                )}
              </div>

              <div className={styles.liveLayout}>
                <div className={styles.activityLog}>
                  <div className={styles.activityHeader}>
                    reasoning ({activity.length})
                  </div>
                  {activity.map((entry, i) => (
                    <div key={i} className={styles.activityEntry}>
                      {entry.text}
                    </div>
                  ))}
                </div>

                {liveUrl ? (
                  <div className={styles.replayContainer}>
                    <div className={styles.replayHeader}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: 'var(--radius-full)', backgroundColor: 'var(--color-accent-green)', animation: 'pulse 2s infinite' }} />
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>live</span>
                      </span>
                    </div>
                    <iframe src={liveUrl} title="Live browser" className={styles.replayIframe} />
                  </div>
                ) : (
                  <div className={styles.section} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px' }}>
                    <Spinner size="lg" />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Reasoning persists after exploration */}
          {!exploring && !generating && activity.length > 0 && (
            <div className={styles.activityLog} style={{ maxHeight: '200px', marginBottom: 'var(--space-md)' }}>
              <div className={styles.activityHeader}>
                exploration reasoning ({activity.length})
              </div>
              {activity.map((entry, i) => (
                <div key={i} className={styles.activityEntry}>
                  {entry.text}
                </div>
              ))}
            </div>
          )}

          {/* Post-exploration dashboard */}
          {!exploring && !generating && latestRun && (
            <div>
              {/* Completeness bar — full width on top */}
              {doc?.jsonContent && hasSelfAssessment(doc.jsonContent) && (
                <CompletenessBar assessment={(doc.jsonContent as Record<string, unknown>).selfAssessment as SelfAssessment} />
              )}

              {/* Two columns: exploration status (left) + gaps (right) */}
              <div className={styles.dashboardGrid}>
                <div>
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
                    onReExplore={() => handleNewExploration('replace')}
                  />
                </div>

                <div>
                  {/* Gaps */}
                  {doc?.jsonContent && hasSelfAssessment(doc.jsonContent) && (
                    <GapsPanel gaps={((doc.jsonContent as Record<string, unknown>).selfAssessment as SelfAssessment).gaps} />
                  )}

                  {/* Session replay */}
                  <SessionReplay runId={latestRun.id} />
                </div>
              </div>

              {/* Suggested next pages — full width */}
              {doc?.jsonContent && hasSelfAssessment(doc.jsonContent) && (
                <NextPagesPanel
                  nextSteps={((doc.jsonContent as Record<string, unknown>).selfAssessment as SelfAssessment).nextSteps}
                  projectId={projectId!}
                  onPageCreated={async () => {
                    await fetchData()
                    await context.refetchPages()
                  }}
                />
              )}
            </div>
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

// --- Briefing Section (collapsible, numbered steps) ---

const RESOURCE_TYPES: PageResourceDTO['type'][] = ['url', 'credential', 'endpoint', 'file', 'note']
const ALLOWED_FILE_EXTENSIONS = ['.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.xml']
const MAX_FILE_SIZE = 500 * 1024

function BriefingSection({
  page,
  pageId,
  briefing,
  collapsed,
  onPageUpdate,
  onBriefingChange,
}: {
  page: DocPageDTO
  pageId: string
  briefing: PageBriefingDTO
  collapsed: boolean
  onPageUpdate: (updates: Record<string, unknown>) => void
  onBriefingChange: (briefing: PageBriefingDTO) => void
}): React.ReactElement {
  const [open, setOpen] = useState(!collapsed)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [showExample, setShowExample] = useState(false)

  // Auto-collapse when exploration starts
  useEffect(() => {
    if (collapsed) setOpen(false)
  }, [collapsed])

  const update = (partial: Partial<PageBriefingDTO>): void => {
    onBriefingChange({ ...briefing, ...partial })
  }

  const addResource = (): void => {
    update({ resources: [...briefing.resources, { type: 'note', label: '', value: '' }] })
  }

  const updateResource = (index: number, field: keyof PageResourceDTO, value: string): void => {
    update({ resources: briefing.resources.map((r, i) => i === index ? { ...r, [field]: value } : r) })
  }

  const removeResource = (index: number): void => {
    update({ resources: briefing.resources.filter((_, i) => i !== index) })
  }

  const handleFileUpload = async (index: number, e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadError(null)
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase()
    if (!ALLOWED_FILE_EXTENSIONS.includes(ext)) { setUploadError(`Unsupported type. Accepted: ${ALLOWED_FILE_EXTENSIONS.join(', ')}`); return }
    if (file.size > MAX_FILE_SIZE) { setUploadError('File too large (max 500KB)'); return }
    const path = `pages/${pageId}/${file.name}`
    const { error } = await supabase.storage.from('briefing-files').upload(path, file, { upsert: true })
    if (error) { setUploadError(`Upload failed: ${error.message}`); return }
    update({ resources: briefing.resources.map((r, i) => i === index ? { ...r, value: path, label: r.label || file.name } : r) })
  }

  // Count filled fields for the summary badge
  const filledCount = [page.goal, page.startUrl, briefing.objective, briefing.knowledge].filter(Boolean).length + briefing.resources.length

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: 'var(--space-sm)',
    fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)',
    background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-md)', fontFamily: 'var(--font-sans)', outline: 'none',
  }

  const textareaStyle: React.CSSProperties = {
    ...inputStyle, resize: 'vertical', minHeight: '60px',
  }

  return (
    <div className={styles.section}>
      {/* Header — clickable to toggle */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          padding: 0, margin: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-primary)' }}>
            Agent Briefing
          </span>
          <span style={{
            fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
            padding: '1px 6px', borderRadius: 'var(--radius-sm)',
            backgroundColor: filledCount > 2 ? 'rgba(61,214,140,0.15)' : 'rgba(245,166,35,0.15)',
            color: filledCount > 2 ? 'var(--color-accent-green)' : 'var(--color-accent-amber)',
          }}>
            {filledCount > 2 ? 'ready' : `${filledCount}/4 filled`}
          </span>
        </div>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
          &#9662;
        </span>
      </button>

      {!open && (
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: 'var(--space-xs) 0 0' }}>
          {briefing.objective ? briefing.objective.slice(0, 80) + (briefing.objective.length > 80 ? '...' : '') : 'No objective set — click to expand'}
        </p>
      )}

      {/* Expanded content */}
      {open && (
        <div style={{ marginTop: 'var(--space-md)', display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: 0, lineHeight: 1.5 }}>
            The more precise your briefing, the better the documentation — and the less you&apos;ll need to re-run.
          </p>

          {/* Step 1: Goal + URL */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
              <span className={styles.stepNumber}>1</span>
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)' }}>Where to explore</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)' }}>
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', display: 'block', marginBottom: '4px' }}>Start URL</label>
                <input
                  type="text"
                  value={page.startUrl ?? ''}
                  onChange={(e) => onPageUpdate({ startUrl: e.target.value })}
                  placeholder="e.g. /pricing or https://app.com/settings"
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
                />
              </div>
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', display: 'block', marginBottom: '4px' }}>Goal</label>
                <input
                  type="text"
                  value={page.goal ?? ''}
                  onChange={(e) => onPageUpdate({ goal: e.target.value })}
                  placeholder="e.g. Document the pricing and upgrade flow"
                  style={inputStyle}
                />
              </div>
            </div>
          </div>

          {/* Step 2: Objective */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                <span className={styles.stepNumber}>2</span>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)' }}>What to document</span>
              </div>
              <button
                type="button"
                onClick={() => setShowExample(!showExample)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--color-accent-blue)', fontFamily: 'var(--font-mono)' }}
              >
                {showExample ? 'hide example' : 'see example'}
              </button>
            </div>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '0 0 var(--space-sm)', lineHeight: 1.4 }}>
              What should the user learn from this page? Be specific — the agent follows this closely.
            </p>
            {showExample && (
              <div style={{
                fontSize: 'var(--text-xs)', lineHeight: 1.5, padding: 'var(--space-sm)',
                marginBottom: 'var(--space-sm)', backgroundColor: 'var(--color-bg-elevated)', borderRadius: 'var(--radius-md)',
              }}>
                <p style={{ color: 'var(--color-accent-red)', margin: '0 0 4px' }}>Bad: &quot;Document pricing&quot;</p>
                <p style={{ color: 'var(--color-accent-green)', margin: 0 }}>Good: &quot;Document the pricing page: compare plans, show the upgrade flow from free to pro, and explain what happens when the trial expires&quot;</p>
              </div>
            )}
            <textarea
              value={briefing.objective}
              onChange={(e) => update({ objective: e.target.value })}
              placeholder="e.g. Document how a new user creates an account, verifies their email, and completes onboarding"
              rows={3}
              style={textareaStyle}
            />
          </div>

          {/* Step 3: Domain knowledge */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
              <span className={styles.stepNumber}>3</span>
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)' }}>What the agent can&apos;t see</span>
            </div>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '0 0 var(--space-sm)', lineHeight: 1.4 }}>
              Business rules, edge cases, hidden behaviors — anything not obvious from the UI.
            </p>
            <textarea
              value={briefing.knowledge}
              onChange={(e) => update({ knowledge: e.target.value })}
              placeholder="e.g. Free trial users can't access billing. The 'Export' button only appears after 3 entries."
              rows={3}
              style={textareaStyle}
            />
          </div>

          {/* Step 4: Resources */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                <span className={styles.stepNumber}>4</span>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)' }}>Resources</span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>optional</span>
              </div>
              <button type="button" onClick={addResource} style={{
                background: 'none', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)',
                cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)',
                padding: '2px 8px',
              }}>
                + add
              </button>
            </div>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '0 0 var(--space-sm)', lineHeight: 1.4 }}>
              Files the agent can upload into the app, or reference URLs. Credentials go in Project Settings.
            </p>
            {uploadError && (
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-accent-red)', margin: '0 0 var(--space-sm)' }}>{uploadError}</p>
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
                    borderRadius: 'var(--radius-sm)', padding: '4px 6px',
                    fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)',
                  }}
                >
                  {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <input type="text" value={r.label} onChange={(e) => updateResource(i, 'label', e.target.value)}
                  placeholder="label" style={{ ...inputStyle, padding: '4px 8px', fontSize: 'var(--text-xs)' }} />
                {r.type === 'file' ? (
                  r.value ? (
                    <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', padding: '4px 0' }}>
                      {r.value.split('/').pop()}
                    </span>
                  ) : (
                    <input type="file" accept={ALLOWED_FILE_EXTENSIONS.join(',')}
                      onChange={(e) => void handleFileUpload(i, e)}
                      style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }} />
                  )
                ) : (
                  <input type="text" value={r.value} onChange={(e) => updateResource(i, 'value', e.target.value)}
                    placeholder="value" style={{ ...inputStyle, padding: '4px 8px', fontSize: 'var(--text-xs)' }} />
                )}
                <button type="button" onClick={() => removeResource(i)} style={{
                  background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)',
                }}>x</button>
              </div>
            ))}
            {briefing.resources.length === 0 && (
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontStyle: 'italic', margin: 0 }}>
                No resources added
              </p>
            )}
          </div>
        </div>
      )}
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

// --- Video Uploader ---

function VideoUploader({
  projectId,
  pageId,
  page,
  onComplete,
}: {
  projectId: string
  pageId: string
  page: DocPageDTO
  onComplete: () => Promise<void>
}): React.ReactElement {
  const [status, setStatus] = useState<'idle' | 'uploading' | 'analyzing' | 'generating' | 'extracting'>('idle')
  const [error, setError] = useState<string | null>(null)

  const handleVideoUpload = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)

    if (file.size > 500 * 1024 * 1024) {
      setError('Video too large (max 500MB)')
      return
    }

    try {
      // 1. Create a run
      const run = await api.runs.create({
        featureName: page.title,
        startUrl: page.startUrl ?? '',
        goal: page.goal || 'Document from screen recording',
        docPageId: pageId,
      })

      // 2. Upload video via backend (service key)
      setStatus('uploading')
      const videoPath = `runs/${run.id}/video${file.name.substring(file.name.lastIndexOf('.'))}`
      await api.runs.uploadArtifact(run.id, file, videoPath)

      // 3. Analyze with Gemini — returns timestamps for each step
      setStatus('analyzing')
      const { timestamps } = await api.runs.analyzeVideo(run.id, videoPath)

      // 4. Extract frames at exact Gemini timestamps and upload as screenshots
      setStatus('extracting')
      await extractAndUploadFrames(file, run.id, timestamps)

      // 5. Generate doc
      setStatus('generating')
      await api.runs.generateDoc(run.id)
      await dbUpdatePage(projectId, pageId, { status: 'published' })

      await onComplete()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStatus('idle')
    }
  }

  if (status !== 'idle') {
    return (
      <div className={styles.section}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
          <Spinner size="sm" />
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-accent-blue)' }}>
            {status === 'uploading' && 'Uploading video...'}
            {status === 'analyzing' && 'Analyzing video with AI — this may take a minute...'}
            {status === 'extracting' && 'Extracting screenshots...'}
            {status === 'generating' && 'Generating documentation...'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.section}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-sm) 0' }}>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>or</span>
      </div>
      <label style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-lg)', cursor: 'pointer',
        border: '2px dashed var(--color-border-subtle)', borderRadius: 'var(--radius-lg)',
        transition: 'border-color 0.15s',
      }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-secondary)', marginBottom: 'var(--space-xs)' }}>
          Upload a screen recording
        </span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          .mp4, .webm, .mov — max 500MB
        </span>
        <input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(e) => void handleVideoUpload(e)}
          style={{ display: 'none' }} />
      </label>
      {error && <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-accent-red)', marginTop: 'var(--space-sm)' }}>{error}</p>}
    </div>
  )
}

// Extract frames from video at exact Gemini timestamps and upload via backend
async function extractAndUploadFrames(videoFile: File, runId: string, timestamps: number[]): Promise<void> {
  if (timestamps.length === 0) return

  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) { resolve(); return }

    video.onloadedmetadata = () => {
      canvas.width = Math.min(video.videoWidth, 1280)
      canvas.height = Math.round(canvas.width * (video.videoHeight / video.videoWidth))

      let i = 0

      const extractNext = (): void => {
        if (i >= timestamps.length) { resolve(); return }
        video.currentTime = timestamps[i]!
      }

      video.onseeked = () => {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const stepIndex = i
        canvas.toBlob(async (blob) => {
          if (blob) {
            const path = `runs/${runId}/frame-${stepIndex}.jpg`
            await api.runs.uploadArtifact(runId, blob, path, stepIndex)
          }
          i++
          extractNext()
        }, 'image/jpeg', 0.8)
      }

      video.onerror = () => reject(new Error('Failed to load video'))
      extractNext()
    }

    video.onerror = () => reject(new Error('Failed to load video'))
    video.src = URL.createObjectURL(videoFile)
  })
}

function getCompletenessColor(pct: number): string {
  if (pct >= 70) return 'var(--color-accent-green)'
  if (pct >= 40) return 'var(--color-accent-amber)'
  return 'var(--color-accent-red)'
}

function CompletenessBar({ assessment }: { assessment: SelfAssessment }): React.ReactElement {
  const color = getCompletenessColor(assessment.overallCompleteness)
  return (
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
  )
}

function GapsPanel({ gaps }: { gaps: SelfAssessment['gaps'] }): React.ReactElement {
  if (gaps.length === 0) return <></>
  return (
    <div style={{
      padding: 'var(--space-md)', backgroundColor: 'var(--color-bg-surface)',
      border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-lg)',
      marginBottom: 'var(--space-md)',
    }}>
      <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 'var(--space-sm)', color: 'var(--color-accent-amber)', margin: '0 0 var(--space-sm)' }}>
        Gaps ({gaps.length})
      </h3>
      {gaps.map((gap, i) => (
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
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '2px 0 0' }}>{gap.reason}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

function NextPagesPanel({
  nextSteps,
  projectId,
  onPageCreated,
}: {
  nextSteps: SelfAssessment['nextSteps']
  projectId: string
  onPageCreated: () => Promise<void>
}): React.ReactElement {
  const [creatingIndex, setCreatingIndex] = useState<number | null>(null)
  const navigate = useNavigate()

  if (nextSteps.length === 0) return <></>

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

  return (
    <div style={{
      padding: 'var(--space-md)', backgroundColor: 'var(--color-bg-surface)',
      border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-lg)',
    }}>
      <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 'var(--space-md)', color: 'var(--color-accent-blue)', margin: '0 0 var(--space-md)' }}>
        Suggested Next Pages
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
        {nextSteps.map((ns, i) => (
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
  )
}
