import { type ChangeEvent, useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useOutletContext, Link } from 'react-router-dom'
import {
  Button,
  Spinner,
  BlockEditor,
  EmptyState,
  TableOfContents,
} from '../../../design-system/components/index.js'
import { api, type DocPageDTO, type ProjectDTO, type StepEventDTO, type PageBriefingDTO, type PageResourceDTO, type TryDocReportDTO } from '../../../shared/api/client.js'
import { fetchPageFull, updatePage as dbUpdatePage, fetchLatestTestReport } from '../../../shared/api/db.js'
import { supabase } from '../../../shared/api/supabase.js'
import { NarratedPlayer } from '../components/NarratedPlayer.js'
import { ScreenRecorder } from '../components/ScreenRecorder.js'
import { TryDocReport } from '../components/TryDocReport.js'
import styles from './PageView.module.css'

interface PageContext {
  project: ProjectDTO
  pages: DocPageDTO[]
  refetchPages: () => Promise<void>
}

export function PageView(): React.ReactElement {
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>()
  const context = useOutletContext<PageContext>()

  // Instant page lookup from sidebar data — no flash on page switch
  const cachedPage = context.pages.find((p) => p.id === pageId) ?? null

  const [page, setPage] = useState<DocPageDTO | null>(cachedPage)
  const [loading, setLoading] = useState(!cachedPage)
  const abortRef = useRef<AbortController | null>(null)
  const [liveUrl, setLiveUrl] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'doc' | 'exploration' | 'video' | 'test'>('doc')
  const [tryRunning, setTryRunning] = useState(false)
  const [tryStreamSteps, setTryStreamSteps] = useState<{ text: string; timestamp: number }[]>([])
  const [tryReport, setTryReport] = useState<TryDocReportDTO | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [voiceoverUrl, setVoiceoverUrl] = useState<string | null>(null)
  const [voiceoverSegments, setVoiceoverSegments] = useState<{ stepIndex: number; startTime: number; endTime: number; text?: string }[]>([])
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [latestRunId, setLatestRunId] = useState<string | null>(null)
  const [voices, setVoices] = useState<{ voiceId: string; name: string }[]>([])
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | undefined>(undefined)
  const prevPageIdRef = useRef(pageId)

  // Sync page instantly when pageId changes (no async gap)
  if (pageId !== prevPageIdRef.current) {
    prevPageIdRef.current = pageId
    if (cachedPage) {
      setPage(cachedPage)
      setLoading(false)
    } else {
      setPage(null)
      setLoading(true)
    }
    setError(null)
    setLiveUrl(null)
    setStatusMessage(null)
    setActiveTab('doc')
  }

  const fetchData = useCallback(async () => {
    if (!projectId || !pageId) return
    try {
      const [fullData, testReport] = await Promise.all([
        fetchPageFull(pageId),
        fetchLatestTestReport(pageId),
      ])
      const { page: pageData, latestRun: runData, doc: docData } = fullData
      setPage(pageData)
      setTryReport(testReport)

      // Track latest run ID for voiceover generation
      setLatestRunId(runData?.id ?? null)

      // Extract voiceover + video URLs from latest run summary
      // Uses public URLs (artifacts bucket is public)
      const summary = runData?.summaryJson as Record<string, unknown> | null
      const voiceover = summary?.voiceover as {
        audioPath?: string
        audioUrl?: string
        segments?: { stepIndex: number; startTime: number; endTime: number; text?: string }[]
      } | undefined

      if (voiceover?.audioUrl) {
        setVoiceoverUrl(voiceover.audioUrl)
      } else if (voiceover?.audioPath) {
        const { data: audioData } = supabase.storage.from('artifacts').getPublicUrl(voiceover.audioPath)
        setVoiceoverUrl(audioData?.publicUrl ?? null)
      } else {
        setVoiceoverUrl(null)
      }
      setVoiceoverSegments(voiceover?.segments ?? [])

      // Get video URL from summaryJson.videoPath — verify it exists
      const vPath = summary?.videoPath as string | undefined
      if (vPath && runData?.id) {
        const { data: vData } = supabase.storage.from('artifacts').getPublicUrl(vPath)
        // HEAD check to verify file exists (catches stale .mp4 paths from failed ffmpeg)
        const check = await fetch(vData?.publicUrl ?? '', { method: 'HEAD' }).catch(() => null)
        if (check?.ok) {
          setVideoUrl(vData?.publicUrl ?? null)
        } else {
          // Try fallback: original upload format (.webm, .mp4, .mov)
          const basePath = `runs/${runData.id}/video`
          for (const ext of ['.webm', '.mp4', '.mov']) {
            const { data: fallback } = supabase.storage.from('artifacts').getPublicUrl(basePath + ext)
            const fbCheck = await fetch(fallback?.publicUrl ?? '', { method: 'HEAD' }).catch(() => null)
            if (fbCheck?.ok) { setVideoUrl(fallback?.publicUrl ?? null); break }
          }
        }
      } else {
        setVideoUrl(null)
      }

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
    void fetchData()
  }, [fetchData])

  // Fetch available ElevenLabs voices (once on mount)
  useEffect(() => {
    api.runs.getVoices().then((r) => {
      const v = r.voices.map((voice) => ({ voiceId: voice.voiceId, name: voice.name }))
      console.log(`[voices] Loaded ${v.length} voices`)
      setVoices(v)
      if (v.length > 0) setSelectedVoiceId(v[0]!.voiceId)
    }).catch((err) => {
      console.warn('[voices] Failed to load:', err)
    })
  }, [])

  const handleTryDoc = async (): Promise<void> => {
    if (!projectId || !pageId || !page?.content) return
    const startUrl = page.startUrl ?? context.project.baseUrl

    const tryDocPrompt = `You are simulating a NAIVE USER who has ONLY the documentation below. You have never used this product before. You know NOTHING about it except what the documentation tells you.

## Documentation to verify:

${page.content}

## Your task:
1. Navigate to: ${startUrl}
2. Follow EACH step in the documentation IN ORDER, exactly as written
3. For EVERY step, report your experience clearly:
   - PASS: if the step works exactly as documented
   - FAIL: if something doesn't match — explain what's different
   - AMBIGUOUS: if the instruction is vague or could be interpreted multiple ways

NAIVE USER RULES:
- Do NOT fill in gaps in the documentation with your own knowledge
- If the doc says "click Settings" and you see "Preferences" — that is a FAIL
- If the doc assumes you know something it never explained — note it
- If the product shows an error — note the exact error message
- Take a screenshot after each major step

DO NOT generate new documentation. Only verify the existing one.`

    setTryRunning(true)
    setTryStreamSteps([])
    setTryReport(null)
    setAnalyzing(false)
    setLiveUrl(null)
    setActiveTab('test')
    setStatusMessage('Launching browser...')

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const run = await api.runs.create({
        featureName: `[Test] ${page.title}`,
        startUrl,
        goal: `Verify documentation for "${page.title}"`,
        docPageId: pageId,
      })

      // Phase 1: Explore with naive user prompt
      await api.runs.exploreStream(
        run.id,
        (event: StepEventDTO) => {
          switch (event.type) {
            case 'live': setLiveUrl(event.liveUrl ?? null); break
            case 'status':
            case 'step':
              if (event.message && event.message.length > 10) {
                setTryStreamSteps((prev) => [...prev, { text: event.message!, timestamp: Date.now() }])
              }
              setStatusMessage(event.message ?? null)
              break
            case 'done': setStatusMessage('Exploration complete — analyzing results...'); break
            case 'error': setStatusMessage(event.message ?? 'Error'); break
          }
        },
        tryDocPrompt,
        controller.signal,
      )

      if (controller.signal.aborted) return

      // Phase 2: Analyze with Gemini → structured report
      setTryRunning(false)
      setLiveUrl(null)
      setAnalyzing(true)
      setStatusMessage('Generating test report...')

      const report = await api.runs.analyzeTry(run.id, page.content, page.title, pageId)
      setTryReport(report)
      setStatusMessage(null)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message)
      }
    } finally {
      abortRef.current = null
      setTryRunning(false)
      setAnalyzing(false)
      setLiveUrl(null)
    }
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

  const handleSaveContent = async (markdown: string): Promise<void> => {
    if (!projectId || !pageId) return
    await dbUpdatePage(projectId, pageId, { content: markdown })
  }

  if (loading) return <Spinner size="lg" />
  if (!page) return <EmptyState title="Page not found" />



  return (
    <div>
      {/* Header — publish toggle */}
      <div className={styles.pageHeader}>
        <div className={styles.tabBar}>
          <button className={`${styles.tab} ${activeTab === 'doc' ? styles.tabActive : ''}`} onClick={() => setActiveTab('doc')}>Documentation</button>
          <button className={`${styles.tab} ${activeTab === 'exploration' ? styles.tabActive : ''}`} onClick={() => setActiveTab('exploration')}>Generate</button>
          <button className={`${styles.tab} ${activeTab === 'video' ? styles.tabActive : ''}`} onClick={() => setActiveTab('video')}>
            Video
            {(voiceoverUrl || videoUrl) && <span className={`${styles.tabDot} ${styles.tabDotPass}`} />}
          </button>
          <button className={`${styles.tab} ${activeTab === 'test' ? styles.tabActive : ''}`} onClick={() => setActiveTab('test')}>
            Test
            {(tryRunning || analyzing) && <Spinner size="sm" />}
            {!tryRunning && !analyzing && tryReport && (
              <span className={`${styles.tabDot} ${
                tryReport.summary.overallVerdict === 'pass' ? styles.tabDotPass :
                tryReport.summary.overallVerdict === 'fail' ? styles.tabDotFail :
                styles.tabDotPartial
              }`} />
            )}
          </button>
        </div>
        <div
          className={styles.publishToggle}
          onClick={() => {
            const newVal = !page.isPublic
            setPage({ ...page, isPublic: newVal })
            void dbUpdatePage(projectId!, pageId!, { isPublic: newVal })
          }}
        >
          <span style={{ color: page.isPublic ? 'var(--color-success)' : 'var(--color-muted-fg)' }}>
            {page.isPublic ? 'Published' : 'Draft'}
          </span>
          <div className={`${styles.toggleTrack} ${page.isPublic ? styles.toggleTrackOn : ''}`}>
            <div className={`${styles.toggleKnob} ${page.isPublic ? styles.toggleKnobOn : ''}`} />
          </div>
        </div>
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
            key={pageId}
            content={page.content ?? ''}
            onSave={handleSaveContent}
          />
          {/* Notion-style child page links */}
          {(() => {
            const children = context.pages.filter((p) => p.parentId === pageId)
            if (children.length === 0) return null
            return (
              <div className={styles.childPages}>
                {children.map((child) => (
                  <Link key={child.id} to={`/projects/${projectId}/pages/${child.id}`} className={styles.childPageLink}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.342a2 2 0 0 0-.602-1.43l-4.44-4.342A2 2 0 0 0 13.56 2H6a2 2 0 0 0-2 2z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></svg>
                    {child.title}
                  </Link>
                ))}
              </div>
            )
          })()}
          {page.content && <TableOfContents content={page.content} />}
        </div>
      )}

      {/* ===== VIDEO TAB ===== */}
      {activeTab === 'video' && (
        <div className={styles.tabContent}>
          {(voiceoverUrl || voiceoverSegments.length > 0 || videoUrl || latestRunId) ? (
            <>
              <NarratedPlayer
                videoUrl={videoUrl}
                audioUrl={voiceoverUrl}
                segments={voiceoverSegments.length > 0 ? voiceoverSegments : undefined}
                runId={latestRunId}
                voices={voices}
                selectedVoiceId={selectedVoiceId}
                onVoiceChange={setSelectedVoiceId}
                onSegmentsChange={setVoiceoverSegments}
                onVideoUrlChange={setVideoUrl}
                onAudioUrlChange={setVoiceoverUrl}
                onGenerateVoiceover={latestRunId && page.content ? async () => {
                  const result = await api.runs.generateVoiceover(latestRunId, {
                    voiceId: selectedVoiceId,
                  }) as {
                    segments?: { stepIndex: number; startTime: number; endTime: number; text?: string }[]
                    audioPath?: string
                    audioUrl?: string
                  }
                  if (result.audioUrl) {
                    setVoiceoverUrl(result.audioUrl)
                  } else if (result.audioPath) {
                    const { data } = supabase.storage.from('artifacts').getPublicUrl(result.audioPath)
                    setVoiceoverUrl(data?.publicUrl ?? null)
                  }
                  setVoiceoverSegments(result.segments ?? [])
                } : undefined}
              />
              {/* Show on public page toggle */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
                padding: 'var(--space-sm) var(--space-md)',
                background: 'var(--color-card)', border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-lg)', marginTop: 'var(--space-sm)',
              }}>
                <div
                  className={styles.publishToggle}
                  onClick={() => {
                    const current = (page.briefing as Record<string, unknown> | null)?.showVideoOnPublic as boolean | undefined
                    const newVal = !current
                    const newBriefing = { ...(page.briefing ?? {}), showVideoOnPublic: newVal } as typeof page.briefing
                    setPage({ ...page, briefing: newBriefing })
                    void dbUpdatePage(projectId!, pageId!, { briefing: newBriefing })
                  }}
                >
                  <span style={{
                    color: (page.briefing as Record<string, unknown> | null)?.showVideoOnPublic
                      ? 'var(--color-success)' : 'var(--color-muted-fg)',
                    fontSize: 'var(--text-sm)',
                    fontFamily: 'var(--font-sans)',
                    textTransform: 'none',
                    letterSpacing: 'normal',
                  }}>
                    Display video on published page
                  </span>
                  <div className={`${styles.toggleTrack} ${(page.briefing as Record<string, unknown> | null)?.showVideoOnPublic ? styles.toggleTrackOn : ''}`}>
                    <div className={`${styles.toggleKnob} ${(page.briefing as Record<string, unknown> | null)?.showVideoOnPublic ? styles.toggleKnobOn : ''}`} />
                  </div>
                </div>
              </div>
            </>
          ) : (
            <EmptyState
              title="No video yet"
              description="Record or upload a video in the Generate tab to create a narrated walkthrough."
            />
          )}
        </div>
      )}

      {/* ===== GENERATE TAB ===== */}
      {activeTab === 'exploration' && (
        <div className={styles.tabContent}>

          <BriefingSection
            page={page}
            pageId={pageId!}
            briefing={{ objective: '', knowledge: '', resources: [], ...(page.briefing ?? {}) }}
            collapsed={false}
            onPageUpdate={(updates) => {
              setPage({ ...page, ...updates })
              void debouncedPageUpdate(updates)
            }}
            onBriefingChange={(briefing) => {
              setPage({ ...page, briefing })
              void debouncedPageUpdate({ briefing })
            }}
          />

          <ScreenRecorder
            projectId={projectId!}
            pageId={pageId!}
            page={page}
            onComplete={async () => {
              await fetchData()
              await context.refetchPages()
              setActiveTab('doc')
            }}
          />

          {error && <EmptyState title="Error" description={error} />}
        </div>
      )}

      {/* ===== TEST TAB ===== */}
      {activeTab === 'test' && (
        <div className={styles.tabContent}>
          <div className={styles.tryHeader}>
            <div className={styles.tryTitleRow}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /><path d="m9 15 2 2 4-4" /></svg>
              <h2 className={styles.tryTitle}>Documentation Test</h2>
              {(tryRunning || analyzing) && <Spinner size="sm" />}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <p className={styles.trySubtitle}>
                {tryRunning
                  ? statusMessage ?? 'AI is following your documentation steps...'
                  : analyzing
                    ? 'Analyzing results with Gemini...'
                    : tryReport
                      ? `Last tested ${new Date(tryReport.executedAt).toLocaleDateString()}`
                      : 'Verify your documentation against the live application'}
              </p>
              {!tryRunning && !analyzing && (
                <Button size="sm" onClick={() => void handleTryDoc()} disabled={!page.content}>
                  {tryReport ? 'Re-test' : 'Run Test'}
                </Button>
              )}
            </div>
          </div>

          {/* Live browser during test */}
          {tryRunning && liveUrl && (
            <div className={styles.replayContainer} style={{ marginBottom: 'var(--space-md)' }}>
              <div className={styles.replayHeader}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--color-success)', animation: 'pulse 2s infinite' }} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>live</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>Stop</Button>
              </div>
              <iframe src={liveUrl} title="Live browser" className={styles.replayIframe} />
            </div>
          )}

          {/* Live streaming steps */}
          {tryRunning && tryStreamSteps.length > 0 && (
            <div className={styles.activityLog} style={{ maxHeight: '300px', marginBottom: 'var(--space-md)' }}>
              <div className={styles.activityHeader}>verification steps ({tryStreamSteps.length})</div>
              {tryStreamSteps.map((step, i) => (
                <div key={i} className={styles.activityEntry}>{step.text}</div>
              ))}
            </div>
          )}

          {/* Analyzing state */}
          {analyzing && (
            <div className={styles.section} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '200px', gap: 'var(--space-md)' }}>
              <Spinner size="lg" />
              <span style={{ color: 'var(--color-muted-fg)', fontSize: 'var(--text-sm)' }}>Generating structured test report...</span>
            </div>
          )}

          {/* Structured report */}
          {!tryRunning && !analyzing && tryReport && (
            <TryDocReport report={tryReport} />
          )}

          {/* Empty state */}
          {!tryRunning && !analyzing && !tryReport && (
            <EmptyState
              title="No test results yet"
              description="Run a test to verify your documentation against the live application. The AI will follow each step as a naive user and report what works and what doesn't."
              action={<Button onClick={() => void handleTryDoc()} disabled={!page.content}>Run Test</Button>}
            />
          )}
        </div>
      )}
    </div>
  )
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

  return (
    <div className={styles.section}>
      <button type="button" onClick={() => setOpen(!open)} className={styles.briefingHeader}>
        <div className={styles.briefingTitle}>
          <span className={styles.briefingTitleText}>Agent Briefing</span>
          <span className={`${styles.briefingBadge} ${filledCount > 2 ? styles.briefingBadgeReady : styles.briefingBadgePartial}`}>
            {filledCount > 2 ? 'ready' : `${filledCount}/4`}
          </span>
        </div>
        <span className={`${styles.briefingChevron} ${open ? styles.briefingChevronOpen : ''}`}>&#9662;</span>
      </button>

      {!open && (
        <p className={styles.briefingPreview}>
          {briefing.objective ? briefing.objective.slice(0, 80) + (briefing.objective.length > 80 ? '...' : '') : 'No objective set — click to expand'}
        </p>
      )}

      {open && (
        <div className={styles.briefingBody}>
          <p className={styles.briefingHint}>
            The more precise your briefing, the better the documentation.
          </p>

          {/* Step 1: Goal + URL */}
          <div>
            <div className={styles.briefingStepHeader}>
              <span className={styles.stepNumber}>1</span>
              <span className={styles.briefingStepTitle}>Where to explore</span>
            </div>
            <div className={styles.briefingGrid}>
              <div>
                <label className={styles.briefingFieldLabel}>Start URL</label>
                <input type="text" value={page.startUrl ?? ''} onChange={(e) => onPageUpdate({ startUrl: e.target.value })}
                  placeholder="e.g. /pricing" className={`${styles.briefingInput} ${styles.briefingInputMono}`} />
              </div>
              <div>
                <label className={styles.briefingFieldLabel}>Goal</label>
                <input type="text" value={page.goal ?? ''} onChange={(e) => onPageUpdate({ goal: e.target.value })}
                  placeholder="e.g. Document the pricing and upgrade flow" className={styles.briefingInput} />
              </div>
            </div>
          </div>

          {/* Step 2: Objective */}
          <div>
            <div className={styles.briefingStepBetween}>
              <div className={styles.briefingStepHeader} style={{ marginBottom: 0 }}>
                <span className={styles.stepNumber}>2</span>
                <span className={styles.briefingStepTitle}>What to document</span>
              </div>
              <button type="button" onClick={() => setShowExample(!showExample)} className={styles.briefingExampleToggle}>
                {showExample ? 'hide example' : 'see example'}
              </button>
            </div>
            <p className={styles.briefingHint} style={{ marginBottom: 'var(--space-sm)' }}>
              What should the user learn from this page? Be specific.
            </p>
            {showExample && (
              <div className={styles.briefingExample}>
                <p className={styles.briefingExampleBad}>Bad: &quot;Document pricing&quot;</p>
                <p className={styles.briefingExampleGood}>Good: &quot;Document the pricing page: compare plans, show upgrade flow from free to pro&quot;</p>
              </div>
            )}
            <textarea value={briefing.objective} onChange={(e) => update({ objective: e.target.value })}
              placeholder="e.g. Document how a new user creates an account and completes onboarding" rows={3} className={styles.briefingTextarea} />
          </div>

          {/* Step 3: Domain knowledge */}
          <div>
            <div className={styles.briefingStepHeader}>
              <span className={styles.stepNumber}>3</span>
              <span className={styles.briefingStepTitle}>What the agent can&apos;t see</span>
            </div>
            <p className={styles.briefingHint} style={{ marginBottom: 'var(--space-sm)' }}>
              Business rules, edge cases, hidden behaviors.
            </p>
            <textarea value={briefing.knowledge} onChange={(e) => update({ knowledge: e.target.value })}
              placeholder="e.g. Free trial users can't access billing. Export only appears after 3 entries." rows={3} className={styles.briefingTextarea} />
          </div>

          {/* Step 4: Resources */}
          <div>
            <div className={styles.briefingStepBetween}>
              <div className={styles.briefingStepHeader} style={{ marginBottom: 0 }}>
                <span className={styles.stepNumber}>4</span>
                <span className={styles.briefingStepTitle}>Resources</span>
                <span className={styles.briefingHint}>optional</span>
              </div>
              <button type="button" onClick={addResource} className={styles.briefingAddBtn}>+ add</button>
            </div>
            <p className={styles.briefingHint} style={{ marginBottom: 'var(--space-sm)' }}>
              Files the agent can upload, or reference URLs.
            </p>
            {uploadError && <p className={styles.briefingError}>{uploadError}</p>}
            {briefing.resources.map((r, i) => (
              <div key={i} className={styles.briefingResourceRow}>
                <select value={r.type} onChange={(e) => updateResource(i, 'type', e.target.value)} className={styles.briefingResourceSelect}>
                  {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <input type="text" value={r.label} onChange={(e) => updateResource(i, 'label', e.target.value)}
                  placeholder="label" className={styles.briefingResourceSmallInput} />
                {r.type === 'file' ? (
                  r.value ? (
                    <span className={styles.briefingHint}>{r.value.split('/').pop()}</span>
                  ) : (
                    <input type="file" accept={ALLOWED_FILE_EXTENSIONS.join(',')} onChange={(e) => void handleFileUpload(i, e)}
                      className={styles.briefingHint} />
                  )
                ) : (
                  <input type="text" value={r.value} onChange={(e) => updateResource(i, 'value', e.target.value)}
                    placeholder="value" className={styles.briefingResourceSmallInput} />
                )}
                <button type="button" onClick={() => removeResource(i)} className={styles.briefingResourceRemove}>x</button>
              </div>
            ))}
            {briefing.resources.length === 0 && <p className={styles.briefingEmpty}>No resources added</p>}
          </div>
        </div>
      )}
    </div>
  )
}

