import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import { useParams, useOutletContext, Link } from 'react-router-dom'
import { formatRelativeTime } from '../../../shared/util/relativeTime.js'
import {
  Button,
  Spinner,
  EmptyState,
  TableOfContents,
  ProgressLoader,
  useConfirmDialog,
  AlreadyRunningNotice,
} from '../../../design-system/components/index.js'

// BlockEditor pulls BlockNote + Mantine + ProseMirror (~600kb gzipped) and
// is only used in the Documentation tab. Code-split so the project list
// and the rest of PageView don't pay for it on first paint.
const BlockEditor = lazy(() => import('../../../design-system/components/BlockEditor.js').then((m) => ({ default: m.BlockEditor })))
import { api, isAlreadyRunningError, type AlreadyRunningDetails, type DocPageDTO, type ProjectDTO, type StepEventDTO, type TryDocReportDTO, type PreflightResultDTO } from '../../../shared/api/client.js'
import { fetchPageFull, updatePage as dbUpdatePage, fetchLatestTestReport } from '../../../shared/api/db.js'
import { supabase } from '../../../shared/api/supabase.js'
import { useJobs } from '../../../shared/jobs/JobContext.js'
import { useQuotaStatus } from '../../../shared/hooks/useQuotaStatus.js'
import { NarratedPlayer } from '../components/NarratedPlayer.js'
import { VideoTimeline } from '../components/VideoTimeline.js'
import { TryDocReport } from '../components/TryDocReport.js'
import { PreflightPanel } from '../components/PreflightPanel.js'
import { MarketingVideoPanel } from '../components/MarketingVideoPanel.js'
import { GenerationModal } from '../components/GenerationModal.js'
import styles from './PageView.module.css'

interface PageContext {
  project: ProjectDTO
  pages: DocPageDTO[]
  refetchPages: () => Promise<void>
}

export function PageView(): React.ReactElement {
  const { pageId } = useParams<{ pageId: string }>()
  // Force a full remount on page change so every useState/useRef/useEffect
  // restarts cleanly. Kills the render-phase sync hack and the defensive
  // `page.id !== pageId` spinner that used to erase the page mid-navigation.
  return <PageViewInner key={pageId ?? 'none'} />
}

function PageViewInner(): React.ReactElement {
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>()
  const context = useOutletContext<PageContext>()

  // Instant page lookup from sidebar data — no flash on first paint
  const cachedPage = context.pages.find((p) => p.id === pageId) ?? null

  const { addJob, updateJob, failJob, getJobForPage } = useJobs()

  // Restore per-page state from the job context on mount — e.g. if the user
  // navigates to a page that already has a Try Doc running, we want the Test
  // tab open with the live browser iframe, not a stale Doc tab.
  const initialTestJob = getJobForPage(pageId ?? '', 'try-doc')
  const hasRunningTest = initialTestJob?.status === 'running' && !!initialTestJob.liveUrl

  const [page, setPage] = useState<DocPageDTO | null>(cachedPage)
  // Bumped only when the page content changes from an OUTSIDE source
  // (AI regeneration, restore-previous, auto-copy of generated_docs).
  // Composed into the BlockEditor `key` so external updates remount
  // the editor cleanly while user-driven saves leave it untouched.
  const [externalRev, setExternalRev] = useState(0)
  const [loading, setLoading] = useState(!cachedPage)
  const abortRef = useRef<AbortController | null>(null)
  const [liveUrl, setLiveUrl] = useState<string | null>(hasRunningTest ? (initialTestJob.liveUrl ?? null) : null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'doc' | 'video' | 'test' | 'marketing'>(hasRunningTest ? 'test' : 'doc')
  // The old "Generate" tab is now an action launched from the header CTA
  // (and the Documentation tab empty-state) — opens a modal that wraps the
  // briefing form + ScreenRecorder in a 2-step stepper.
  const [generationModalOpen, setGenerationModalOpen] = useState(false)
  const [tryRunning, setTryRunning] = useState(false)
  const [tryStreamSteps, setTryStreamSteps] = useState<{ text: string; timestamp: number }[]>([])
  const [tryReport, setTryReport] = useState<TryDocReportDTO | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [preflightResult, setPreflightResult] = useState<PreflightResultDTO | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(false)
  const [voiceoverUrl, setVoiceoverUrl] = useState<string | null>(null)
  const [voiceoverSegments, setVoiceoverSegments] = useState<{ stepIndex: number; startTime: number; endTime: number; text?: string }[]>([])
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoDuration, setVideoDuration] = useState(0)
  const [latestRunId, setLatestRunId] = useState<string | null>(null)
  const [voices, setVoices] = useState<{ voiceId: string; name: string }[]>([])
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | undefined>(undefined)
  const [selectedTone, setSelectedTone] = useState<string>('friendly')
  const { dialog: confirmDialog, confirm } = useConfirmDialog()
  const quota = useQuotaStatus()
  const quotaBlocked = !quota.loading && !quota.allowed
  const [generatingVoiceover, setGeneratingVoiceover] = useState(() => getJobForPage(pageId ?? '', 'voiceover')?.status === 'running')
  const [uploadingVideo, setUploadingVideo] = useState(false)
  const activeDocGenJob = getJobForPage(pageId ?? '', 'doc-gen')
  // When a teammate is already running one of the heavy actions on this
  // page, the backend returns 409 RUN_ALREADY_RUNNING with details — we
  // surface them in a shared notice instead of a raw error banner.
  const [alreadyRunning, setAlreadyRunning] = useState<AlreadyRunningDetails | null>(null)
  const activeVoiceoverJob = getJobForPage(pageId ?? '', 'voiceover')
  const activeTryDocJob = getJobForPage(pageId ?? '', 'try-doc')

  // Restore live browser URL from job context when returning to a page with active test
  useEffect(() => {
    if (activeTryDocJob?.status === 'running' && activeTryDocJob.liveUrl && !liveUrl) {
      setLiveUrl(activeTryDocJob.liveUrl)
    }
  }, [activeTryDocJob, liveUrl])

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

      // If doc exists but page.content is empty, copy it over.
      // Backend route so the auto-copy also re-indexes embeddings.
      if (docData?.markdownContent && !pageData.content) {
        void api.pages.update(projectId, pageId, { content: docData.markdownContent })
        setPage({ ...pageData, content: docData.markdownContent })
        setExternalRev((n) => n + 1)
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

  // Auto-refresh page data when a background voiceover job completes
  const prevVoiceoverStatus = useRef(activeVoiceoverJob?.status)
  useEffect(() => {
    if (prevVoiceoverStatus.current === 'running' && activeVoiceoverJob?.status === 'completed') {
      void fetchData()
      setGeneratingVoiceover(false)
    }
    prevVoiceoverStatus.current = activeVoiceoverJob?.status
  }, [activeVoiceoverJob?.status, fetchData])

  // Auto-refresh when background doc-gen job completes
  const prevDocGenStatus = useRef(activeDocGenJob?.status)
  useEffect(() => {
    if (prevDocGenStatus.current === 'running' && activeDocGenJob?.status === 'completed') {
      void fetchData()
      void context.refetchPages()
      setActiveTab('doc')
      setExternalRev((n) => n + 1)
    }
    prevDocGenStatus.current = activeDocGenJob?.status
  }, [activeDocGenJob?.status, fetchData, context])

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

  const handlePreflight = async (): Promise<void> => {
    if (!projectId || !pageId || !page?.content) return
    setPreflightLoading(true)
    setPreflightResult(null)
    setError(null)
    try {
      const result = await api.pages.preflight(projectId, pageId)
      setPreflightResult(result)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPreflightLoading(false)
    }
  }

  const handleTryDoc = async (): Promise<void> => {
    if (!projectId || !pageId || !page?.content) return
    const briefingData = page.briefing as Record<string, unknown> | null
    const testUrl = (briefingData?.testUrl as string) || page.startUrl || context.project.baseUrl

    setTryRunning(true)
    setTryStreamSteps([])
    setTryReport(null)
    setAnalyzing(false)
    setLiveUrl(null)
    setActiveTab('test')
    setStatusMessage('Launching browser...')

    const controller = new AbortController()
    abortRef.current = controller

    // Run the entire pipeline without await — component can unmount freely.
    // State updates go through refs so they work on remount.
    void (async () => {
      let runId: string | null = null
      try {
        const run = await api.runs.create({
          featureName: `[Test] ${page.title}`,
          startUrl: testUrl,
          goal: `Verify documentation for "${page.title}"`,
          docPageId: pageId,
        })
        runId = run.id
        addJob({ runId: run.id, pageId: pageId!, pageTitle: page.title, type: 'try-doc', status: 'running' })

        // Phase 1: Explore. The server detects the "[Test]" run prefix
        // and swaps in the canonical STRICT TESTER prompt — no client
        // prompt string is shipped.
        await api.runs.exploreStream(
          run.id,
          (event: StepEventDTO) => {
            switch (event.type) {
              case 'live':
                setLiveUrl(event.liveUrl ?? null)
                if (event.liveUrl) updateJob(run.id, { liveUrl: event.liveUrl })
                break
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
          undefined,
          controller.signal,
        )

        if (controller.signal.aborted) return

        // Phase 2: Analyze with Gemini → structured report
        setTryRunning(false)
        setLiveUrl(null)
        updateJob(run.id, { liveUrl: undefined, phaseStartedAt: Date.now() })
        setAnalyzing(true)
        setStatusMessage('Generating test report...')

        const report = await api.runs.analyzeTry(run.id, page.content ?? '', page.title, pageId)
        setTryReport(report)
        setStatusMessage(null)
        if (runId) updateJob(runId, { status: 'completed' })
      } catch (err) {
        const e = err as Error & { code?: string | null }
        if (isAlreadyRunningError(err)) {
          // A teammate is already running exploration or Try Doc analysis
          // on this page — surface the notice instead of a generic error.
          setAlreadyRunning(err.details)
        } else if (e.name !== 'AbortError') {
          setError(e.message)
        }
        if (runId) failJob(runId, e.message, e.code ?? null)
      } finally {
        abortRef.current = null
        setTryRunning(false)
        setAnalyzing(false)
        setLiveUrl(null)
      }
    })()
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

  const handleSaveContent = async (markdown: string, blocks: unknown): Promise<void> => {
    if (!projectId || !pageId) return
    // Route content saves through the backend (PUT /projects/:pid/pages/:id)
    // instead of a direct Supabase write. page.service.updatePage detects
    // the content change and re-indexes doc_embeddings so the chat doesn't
    // drift off the edited doc.
    await api.pages.update(projectId, pageId, { content: markdown, contentBlocks: blocks })
    // Update local + sidebar cache so navigation doesn't show stale content
    setPage((prev) => prev ? { ...prev, content: markdown, contentBlocks: blocks } : prev)
    void context.refetchPages()
  }

  if (loading) return (
    <div className={styles.loadingSkeleton}>
      <Spinner size="md" />
    </div>
  )
  if (!page) return <EmptyState title="Page not found" />

  return (
    <div>
      {confirmDialog}
      {alreadyRunning && (
        <AlreadyRunningNotice
          details={alreadyRunning}
          onClose={() => setAlreadyRunning(null)}
        />
      )}
      {/* Header — publish toggle */}
      <div className={styles.pageHeader}>
        <div className={styles.tabBar}>
          <button className={`${styles.tab} ${activeTab === 'doc' ? styles.tabActive : ''}`} onClick={() => setActiveTab('doc')}>Documentation</button>
          <button
            className={`${styles.tab} ${activeTab === 'video' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('video')}
            title="The walkthrough video for this feature: recorded demo + AI voice-over."
          >
            Walkthrough
            {(voiceoverUrl || videoUrl) && <span className={`${styles.tabDot} ${styles.tabDotPass}`} />}
          </button>
          <button className={`${styles.tab} ${activeTab === 'test' ? styles.tabActive : ''}`} onClick={() => setActiveTab('test')}>
            Test
            {(tryRunning || analyzing || activeTryDocJob?.status === 'running') && <Spinner size="sm" />}
            {!tryRunning && !analyzing && activeTryDocJob?.status !== 'running' && tryReport && (
              <span className={`${styles.tabDot} ${
                tryReport.summary.overallVerdict === 'pass' ? styles.tabDotPass :
                tryReport.summary.overallVerdict === 'fail' ? styles.tabDotFail :
                styles.tabDotPartial
              }`} />
            )}
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'marketing' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('marketing')}
            title="A 45s marketing/promo video generated from this page — different from the walkthrough."
          >
            Marketing
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          {/* Primary CTA — opens the generation modal. When the page has no
              content yet this is the user's main next action; once a doc
              exists the same button lets them regenerate from a new
              recording. Phrased differently in each state to make intent
              obvious. */}
          <Button
            size="sm"
            variant={page.content ? 'ghost' : 'primary'}
            onClick={() => setGenerationModalOpen(true)}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
              <path d="M12 2a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
            {page.content ? 'Regenerate' : 'Generate doc'}
          </Button>
          <button
            type="button"
            onClick={() => { void api.pages.exportZip(projectId!, pageId!).catch((err: unknown) => { console.error('Export failed:', err) }) }}
            title="Download this page as a ZIP (markdown + media)"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 10px',
              fontSize: 'var(--text-xs)',
              background: 'transparent', border: '1px solid var(--color-border)',
              borderRadius: 6, cursor: 'pointer',
              color: 'var(--color-muted-fg)',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Export
          </button>
          <div
            className={styles.publishToggle}
            onClick={() => {
              const newVal = !page.isPublic
              setPage({ ...page, isPublic: newVal })
              void dbUpdatePage(projectId!, pageId!, { isPublic: newVal }).then(() => context.refetchPages())
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
      </div>

      {/* Top-level error banner — surfaces failures from Try Doc + page
          fetches that previously displayed inside the (now-removed) Generate
          tab. Keep it inline so it can't be missed when tab-switching. */}
      {error && (
        <div className={styles.errorBanner}>
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className={styles.errorBannerClose} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* ===== DOCUMENTATION TAB ===== */}
      {activeTab === 'doc' && (
        <div className={styles.tabContent} style={{ maxWidth: '820px', margin: '0 auto' }}>
          {/* Restore banner — appears after a doc regeneration overwrote
              existing content. One click reverts. */}
          {page.previousContentSavedAt && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
              padding: 'var(--space-sm) var(--space-md)',
              marginBottom: 'var(--space-md)',
              background: 'var(--color-status-running-bg)',
              border: '1px solid var(--color-status-running-border)',
              borderRadius: 'var(--radius-lg)',
              fontSize: 'var(--text-xs)', color: 'var(--color-status-running-text)',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M3 12a9 9 0 1 0 9-9" />
                <polyline points="3 4 3 10 9 10" />
              </svg>
              <span style={{ flex: 1 }}>
                Previous version saved {formatRelativeTime(new Date(page.previousContentSavedAt))}. You can restore it if the regenerated content isn&apos;t what you wanted.
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void (async () => {
                    const ok = await confirm({
                      title: 'Restore previous version?',
                      message: 'The current content will be replaced by the version saved before the last regeneration. This cannot be undone.',
                      confirmLabel: 'Restore',
                      variant: 'primary',
                    })
                    if (!ok) return
                    try {
                      const restored = await api.pages.restorePrevious(projectId!, pageId!)
                      setPage(restored)
                      setExternalRev((n) => n + 1)
                    } catch (err) {
                      console.error('[restore] Failed:', (err as Error).message)
                    }
                  })()
                }}
              >
                Restore
              </Button>
            </div>
          )}
          <input
            className={styles.pageTitle}
            type="text"
            value={page.title}
            onChange={(e) => {
              setPage({ ...page, title: e.target.value })
              void debouncedPageUpdate({ title: e.target.value })
            }}
          />
          {(page.createdBy || page.lastEditedAt) && (
            <p className={styles.pageMeta}>
              {page.createdBy && (
                <>Created by {page.createdByName ?? 'a teammate'}</>
              )}
              {page.createdBy && page.lastEditedAt && <> · </>}
              {page.lastEditedAt && (
                <>Edited by {page.lastEditedByName ?? 'a teammate'} · {formatRelativeTime(page.lastEditedAt)}</>
              )}
            </p>
          )}
          {/* Empty-state CTA — replaces the now-removed "Generate" tab as
              the user's main entry point when the page has no doc yet.
              Without this the editor renders an empty canvas and users
              don't realize they can generate from a recording. */}
          {!page.content ? (
            <div className={styles.emptyDocState}>
              <div className={styles.emptyDocIcon}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="9" y1="13" x2="15" y2="13" />
                  <line x1="9" y1="17" x2="13" y2="17" />
                </svg>
              </div>
              <h3 className={styles.emptyDocTitle}>This page has no documentation yet</h3>
              <p className={styles.emptyDocText}>
                Record your screen or upload a video — the AI extracts key screenshots and writes the doc for you.
                You can also start writing manually below.
              </p>
              <div className={styles.emptyDocActions}>
                <Button onClick={() => setGenerationModalOpen(true)} variant="primary">
                  Generate from recording
                </Button>
                <Button onClick={() => setExternalRev((n) => n + 1)} variant="ghost">
                  Write manually
                </Button>
              </div>
            </div>
          ) : null}
          <Suspense fallback={<div style={{ padding: '2rem' }}><Spinner size="md" /></div>}>
            <BlockEditor
              key={`${pageId}-${externalRev}`}
              content={page.content ?? ''}
              contentBlocks={page.contentBlocks}
              onSave={handleSaveContent}
            />
          </Suspense>
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

      {/* ===== WALKTHROUGH TAB =====
          The recorded screen capture of the feature being documented +
          its AI voice-over. Distinct from the Marketing tab, which
          generates a 45s promo video from the same page content. */}
      {activeTab === 'video' && (
        <div className={styles.tabContent} style={{ maxWidth: '960px', margin: '0 auto' }}>
          <div style={{ marginBottom: 'var(--space-md)' }}>
            <h2 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600 }}>Walkthrough video</h2>
            <p style={{ margin: '4px 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)' }}>
              The recorded demo of this feature, narrated by the AI voice-over. Embedded on the public docs page above the written content.
            </p>
          </div>
          {(videoUrl || latestRunId) ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
              {/* Publish toggle — show video on public documentation page */}
              <div
                onClick={() => {
                  const current = (page.briefing as Record<string, unknown> | null)?.showVideoOnPublic as boolean | undefined
                  const newVal = !current
                  const newBriefing = { ...(page.briefing ?? {}), showVideoOnPublic: newVal } as typeof page.briefing
                  setPage({ ...page, briefing: newBriefing })
                  void dbUpdatePage(projectId!, pageId!, { briefing: newBriefing })
                }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: 'var(--space-sm) var(--space-md)',
                  background: (page.briefing as Record<string, unknown> | null)?.showVideoOnPublic ? 'var(--color-status-completed-bg)' : 'var(--color-secondary)',
                  border: `1px solid ${(page.briefing as Record<string, unknown> | null)?.showVideoOnPublic ? 'var(--color-status-completed-border)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-lg)', cursor: 'pointer', transition: 'all 0.15s',
                }}
              >
                <div>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-fg)' }}>
                    Show video on published page
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>
                    Display this video at the top of your public documentation
                  </div>
                </div>
                <div className={`${styles.toggleTrack} ${(page.briefing as Record<string, unknown> | null)?.showVideoOnPublic ? styles.toggleTrackOn : ''}`}>
                  <div className={`${styles.toggleKnob} ${(page.briefing as Record<string, unknown> | null)?.showVideoOnPublic ? styles.toggleKnobOn : ''}`} />
                </div>
              </div>

              {/* Explanation */}
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)', margin: 0, lineHeight: 1.6 }}>
                Configure the AI voice-over for your video. Choose a tone and voice, then generate — the narration syncs automatically with the recording.
              </p>

              {/* Controls bar */}
              <div className={styles.videoToolbar} style={{ borderRadius: 'var(--radius-xl)', border: '1px solid var(--color-border)' }}>
                <div className={styles.videoToolbarGroup}>
                  <span className={styles.videoToolbarLabel}>Tone</span>
                  <select value={selectedTone} onChange={(e) => setSelectedTone(e.target.value)} className={styles.videoSelect}>
                    <option value="friendly">Friendly</option>
                    <option value="professional">Professional</option>
                    <option value="energetic">Energetic</option>
                    <option value="calm">Calm</option>
                    <option value="playful">Playful</option>
                  </select>
                </div>
                {voices.length > 0 && (
                  <div className={styles.videoToolbarGroup}>
                    <span className={styles.videoToolbarLabel}>Voice</span>
                    <select value={selectedVoiceId ?? ''} onChange={(e) => setSelectedVoiceId(e.target.value)} className={styles.videoSelect}>
                      {voices.map((v) => <option key={v.voiceId} value={v.voiceId}>{v.name}</option>)}
                    </select>
                  </div>
                )}
                <div style={{ flex: 1 }} />

                {/* Replace video */}
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: uploadingVideo ? 'default' : 'pointer', fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', padding: '4px 8px', borderRadius: 'var(--radius-md)', transition: 'color 0.15s', opacity: uploadingVideo ? 0.6 : 1, pointerEvents: uploadingVideo ? 'none' : 'auto' }}>
                  {uploadingVideo ? (
                    <>
                      <Spinner size="sm" />
                      Uploading…
                    </>
                  ) : (
                    <>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></svg>
                      Replace
                    </>
                  )}
                  <input type="file" accept="video/mp4,video/webm,video/quicktime" disabled={uploadingVideo} style={{ display: 'none' }} onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (!file || !latestRunId) return
                    // Hard cap: native macOS QuickTime recordings can easily hit
                    // 1 GB for a short session and then hang the upload for minutes.
                    const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
                    if (file.size > MAX_UPLOAD_BYTES) {
                      void confirm({
                        title: 'Video too large',
                        message: `This file is ${(file.size / 1024 / 1024).toFixed(0)} MB. Replace only accepts videos under 200 MB. Compress it first, or use the built-in Record button which produces compact recordings.`,
                        confirmLabel: 'OK',
                        variant: 'primary',
                      })
                      e.target.value = ''
                      return
                    }
                    void (async () => {
                      setUploadingVideo(true)
                      try {
                        const ext = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')) : '.mp4'
                        const path = `runs/${latestRunId}/video${ext}`
                        const { signedUrl } = await api.runs.getSignedUploadUrl(latestRunId, path)
                        const uploadRes = await fetch(signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
                        if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.statusText}`)
                        // Persist the new videoPath on summary_json — Replace
                        // writes the file under the chosen extension, which
                        // may differ from the one stored in summary_json
                        // (e.g. old path pointed to an .mp4 produced by
                        // convertToMp4, new upload is a .mov). Without this,
                        // fetchData() either loads the stale path or returns
                        // undefined and the player goes blank.
                        await api.runs.attachVideo(latestRunId, path)
                        const publicUrl = supabase.storage.from('artifacts').getPublicUrl(path).data?.publicUrl
                        if (publicUrl) setVideoUrl(`${publicUrl}?t=${Date.now()}`)
                        setVoiceoverUrl(null)
                        setVoiceoverSegments([])
                        // Refresh to pick up new video path
                        await fetchData()
                      } catch (err) {
                        console.error('[replace] Failed:', (err as Error).message)
                      } finally {
                        setUploadingVideo(false)
                      }
                    })()
                  }} />
                </label>

                {latestRunId && page.content && (
                  <Button size="sm" disabled={generatingVoiceover || activeVoiceoverJob?.status === 'running' || quotaBlocked} onClick={() => {
                    void (async () => {
                      if (quotaBlocked) {
                        await confirm({
                          title: 'Monthly quota exhausted',
                          message: `Your ${quota.planName ?? 'current'} plan is at ${Math.round(quota.percent)}%. Upgrade in Account → Billing to continue generating voice-overs.`,
                          confirmLabel: 'OK',
                          cancelLabel: 'Dismiss',
                          variant: 'primary',
                        })
                        return
                      }
                      if (voiceoverUrl) {
                        const ok = await confirm({ title: 'Replace voice-over?', message: 'The existing voice-over will be permanently replaced by the new generation.', confirmLabel: 'Replace', variant: 'danger' })
                        if (!ok) return
                      }
                      setGeneratingVoiceover(true)
                      addJob({ runId: latestRunId, pageId: pageId!, pageTitle: page.title, type: 'voiceover', status: 'running' })
                      void (async () => {
                        try {
                          const result = await api.runs.generateVoiceover(latestRunId, {
                            voiceId: selectedVoiceId,
                            tone: selectedTone,
                            videoDuration: videoDuration || undefined,
                          }) as {
                            segments?: { stepIndex: number; startTime: number; endTime: number; text?: string }[]
                            audioPath?: string
                            audioUrl?: string
                          }
                          const bust = (url: string): string => `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
                          if (result.audioUrl) {
                            setVoiceoverUrl(bust(result.audioUrl))
                          } else if (result.audioPath) {
                            const { data } = supabase.storage.from('artifacts').getPublicUrl(result.audioPath)
                            setVoiceoverUrl(data?.publicUrl ? bust(data.publicUrl) : null)
                          }
                          setVoiceoverSegments(result.segments ?? [])
                          await fetchData()
                        } catch (err) {
                          const e = err as Error & { code?: string | null }
                          if (isAlreadyRunningError(err)) {
                            setAlreadyRunning(err.details)
                          }
                          failJob(latestRunId, e.message, e.code ?? null)
                        } finally {
                          setGeneratingVoiceover(false)
                        }
                      })()
                    })()
                  }}>
                    {voiceoverUrl ? 'Regenerate' : 'Generate voice-over'}
                  </Button>
                )}
              </div>

              {/* Generation progress */}
              {/* Generation progress — use local state only, not job status (job completes before HTTP response arrives) */}
              {generatingVoiceover && (
                <ProgressLoader
                  startedAt={activeVoiceoverJob?.startedAt}
                  steps={[
                    { label: 'Uploading video to AI', estimatedSeconds: 30 },
                    { label: 'Writing narration script', estimatedSeconds: 30 },
                    { label: 'Synthesizing audio', estimatedSeconds: 60 },
                  ]}
                  activeStep={0}
                />
              )}

              {/* Video player */}
              <div className={styles.videoCard}>
                <NarratedPlayer videoUrl={videoUrl} audioUrl={voiceoverUrl} onDurationChange={setVideoDuration} />
              </div>

              {/* Segment timeline + text editor */}
              {voiceoverSegments.length > 0 && latestRunId && videoDuration > 0 && (
                <>
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 'var(--space-sm)',
                    padding: 'var(--space-sm) var(--space-md)',
                    background: 'var(--color-status-running-bg)',
                    border: '1px solid var(--color-status-running-border)',
                    borderRadius: 'var(--radius-lg)',
                    fontSize: 'var(--text-xs)', color: 'var(--color-status-running-text)', lineHeight: 1.5,
                  }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
                    <span>
                      <strong>Tip:</strong> Click any segment text to edit it, then press Enter to regenerate just that section. Use the trim handles on the timeline to cut the video start/end.
                    </span>
                  </div>
                  <div className={styles.section} style={{ padding: 0, overflow: 'hidden' }}>
                    <VideoTimeline
                      runId={latestRunId}
                      duration={videoDuration}
                      segments={voiceoverSegments}
                      voiceId={selectedVoiceId}
                      onSegmentsChange={setVoiceoverSegments}
                      onVideoTrimmed={(url) => setVideoUrl(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`)}
                      onAudioUrlChange={(url) => setVoiceoverUrl(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`)}
                    />
                  </div>
                </>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
              <div style={{
                padding: 'var(--space-lg)',
                border: '1px dashed var(--color-border)',
                borderRadius: 'var(--radius-xl)',
                display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)',
                alignItems: 'flex-start',
              }}>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-fg)' }}>
                  Attach a video to this page
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', lineHeight: 1.6 }}>
                  Upload a video walkthrough to display alongside your written documentation.
                  The page content stays untouched — no AI generation, no overwrite. Once attached,
                  you can generate a voice-over from your written docs using the Generate voice-over button.
                </div>
                <label style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px',
                  fontSize: 'var(--text-xs)', fontWeight: 500,
                  color: 'var(--color-on-primary, #fff)',
                  background: 'var(--color-primary)',
                  border: '1px solid var(--color-primary)',
                  borderRadius: 'var(--radius-md)',
                  cursor: uploadingVideo ? 'default' : 'pointer',
                  opacity: uploadingVideo ? 0.7 : 1,
                  pointerEvents: uploadingVideo ? 'none' : 'auto',
                }}>
                  {uploadingVideo ? (
                    <>
                      <Spinner size="sm" />
                      Uploading…
                    </>
                  ) : (
                    <>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <path d="m17 8-5-5-5 5" />
                        <path d="M12 3v12" />
                      </svg>
                      Attach video only
                    </>
                  )}
                  <input
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime"
                    disabled={uploadingVideo}
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      // Same 200 MB cap as the Replace flow — keeps the upload
                      // bounded to something that survives flaky networks.
                      const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
                      if (file.size > MAX_UPLOAD_BYTES) {
                        void confirm({
                          title: 'Video too large',
                          message: `This file is ${(file.size / 1024 / 1024).toFixed(0)} MB. Attach only accepts videos under 200 MB.`,
                          confirmLabel: 'OK',
                          variant: 'primary',
                        })
                        e.target.value = ''
                        return
                      }
                      void (async () => {
                        setUploadingVideo(true)
                        try {
                          // Create a run linked to the page so the existing
                          // Video-tab code paths (voice-over button, player)
                          // light up without further plumbing. The run is
                          // used purely as a container for the video URL —
                          // no analyze-video, no doc generation.
                          const run = await api.runs.create({
                            featureName: page.title,
                            startUrl: page.startUrl ?? '',
                            goal: page.goal || 'Attached video walkthrough',
                            docPageId: pageId!,
                          })
                          const ext = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')) : '.mp4'
                          const path = `runs/${run.id}/video${ext}`
                          const { signedUrl } = await api.runs.getSignedUploadUrl(run.id, path)
                          const uploadRes = await fetch(signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
                          if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.statusText}`)
                          // Persist videoPath on the run's summary_json so
                          // fetchData() finds it on reload — otherwise the
                          // Video tab resolves videoPath=undefined and the
                          // player stays hidden even though the file IS in
                          // storage.
                          await api.runs.attachVideo(run.id, path)
                          const publicUrl = supabase.storage.from('artifacts').getPublicUrl(path).data?.publicUrl
                          if (publicUrl) setVideoUrl(`${publicUrl}?t=${Date.now()}`)
                          // Refresh so latestRunId / videoUrl pickup and the
                          // full Video tab UI (tone / voice / generate) renders.
                          await fetchData()
                        } catch (err) {
                          console.error('[attach-video] Failed:', (err as Error).message)
                        } finally {
                          setUploadingVideo(false)
                        }
                      })()
                    }}
                  />
                </label>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>
                  Need an AI-written doc from your recording instead? Use the <strong>Generate</strong> tab.
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== TEST TAB ===== */}
      {activeTab === 'test' && (
        <div className={styles.tabContent}>
          {/* Not running — show config + run button or results */}
          {!tryRunning && !analyzing && !(activeTryDocJob?.status === 'running') && (
            <>
              {/* Two-column: config + action */}
              <div className={styles.generateGrid}>
                {/* Left — Test configuration */}
                <TestConfig
                  page={page}
                  project={context.project}
                  onBriefingChange={(newBriefing) => {
                    setPage({ ...page, briefing: newBriefing })
                    void debouncedPageUpdate({ briefing: newBriefing })
                  }}
                />

                {/* Right — Run action + status */}
                <div className={styles.section} style={{ margin: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-fg)', marginBottom: 'var(--space-sm)' }}>
                      Documentation Test
                    </div>
                    <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', margin: '0 0 var(--space-lg)', lineHeight: 1.5 }}>
                      An AI agent follows your documentation step-by-step as a naive user on the live application and reports what works and what doesn&apos;t.
                    </p>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                    {tryReport && !preflightResult && (
                      <div style={{
                        padding: 'var(--space-sm) var(--space-md)', background: 'var(--color-secondary)',
                        borderRadius: 'var(--radius-md)', fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)',
                      }}>
                        Last tested {new Date(tryReport.executedAt).toLocaleDateString()} — {tryReport.summary.overallVerdict}
                      </div>
                    )}
                    {preflightLoading && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', padding: 'var(--space-sm) 0' }}>
                        <Spinner size="sm" />
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>Checking test readiness...</span>
                      </div>
                    )}
                    {!preflightResult && !preflightLoading && (
                      <Button
                        onClick={() => void (async () => {
                          if (quotaBlocked) {
                            await confirm({
                              title: 'Monthly quota exhausted',
                              message: `Your ${quota.planName ?? 'current'} plan is at ${Math.round(quota.percent)}%. Upgrade in Account → Billing to run more tests.`,
                              confirmLabel: 'OK',
                              cancelLabel: 'Dismiss',
                              variant: 'primary',
                            })
                            return
                          }
                          await handlePreflight()
                        })()}
                        disabled={!page.content || quotaBlocked}
                      >
                        {tryReport ? 'Re-test documentation' : 'Run test'}
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* Pre-flight check results */}
              {preflightResult && (
                <div style={{ marginTop: 'var(--space-md)' }}>
                  <PreflightPanel
                    result={preflightResult}
                    onConfirm={() => { setPreflightResult(null); void handleTryDoc() }}
                    onDismiss={() => setPreflightResult(null)}
                  />
                </div>
              )}

              {/* Report below */}
              {tryReport && (
                <div style={{ marginTop: 'var(--space-md)' }}>
                  <TryDocReport report={tryReport} />
                </div>
              )}
            </>
          )}

          {/* Running — live browser + steps (also shows when returning to page with active test) */}
          {(tryRunning || (activeTryDocJob?.status === 'running' && liveUrl)) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                  <Spinner size="sm" />
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-fg)' }}>
                    {statusMessage ?? 'AI is following your documentation steps...'}
                  </span>
                </div>
                <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>Stop</Button>
              </div>

              {liveUrl && (
                <div className={styles.replayContainer}>
                  <div className={styles.replayHeader}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--color-success)', animation: 'pulse 2s infinite' }} />
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>live</span>
                    </span>
                  </div>
                  <iframe src={liveUrl} title="Live browser" className={styles.replayIframe} />
                </div>
              )}

              {tryStreamSteps.length > 0 && (
                <div className={styles.activityLog} style={{ maxHeight: '300px' }}>
                  <div className={styles.activityHeader}>verification steps ({tryStreamSteps.length})</div>
                  {tryStreamSteps.map((step, i) => (
                    <div key={i} className={styles.activityEntry}>{step.text}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Analyzing — also show when returning to page with active try-doc job that has no liveUrl (exploration done, analysis in progress) */}
          {(analyzing || (activeTryDocJob?.status === 'running' && !liveUrl && !tryRunning)) && (
            <ProgressLoader
              startedAt={activeTryDocJob?.phaseStartedAt}
              steps={[{ label: 'Generating structured test report', estimatedSeconds: 20 }]}
              activeStep={0}
            />
          )}
        </div>
      )}

      {/* Generation modal — replaces the old "Generate" tab. Mounted at the
          root so it overlays everything; ScreenRecorder fires onComplete
          which closes the modal and lets the JobBadge handle progress. */}
      {generationModalOpen && projectId && pageId && (
        <GenerationModal
          projectId={projectId}
          pageId={pageId}
          page={page}
          hasExistingVoiceover={!!voiceoverUrl}
          onGoalChange={(goal) => {
            setPage({ ...page, goal })
            void debouncedPageUpdate({ goal })
          }}
          onBriefingChange={(briefing) => {
            setPage({ ...page, briefing })
            void debouncedPageUpdate({ briefing })
          }}
          onComplete={async () => {
            await fetchData()
            await context.refetchPages()
            setActiveTab('doc')
          }}
          onClose={() => setGenerationModalOpen(false)}
        />
      )}

      {/* ===== MARKETING TAB =====
          The panel renders even without a run: pages with manually-typed
          content (no video) can still produce a marketing video, locked
          to "designed mocks" visualMode. A stub run is auto-created on
          first Generate so the run-scoped pipeline has a container. */}
      {activeTab === 'marketing' && pageId && (
        <div className={styles.tabContent}>
          <MarketingVideoPanel
            runId={latestRunId}
            pageId={pageId}
            pageTitle={page.title}
            fallbackStartUrl={page.startUrl ?? context.project.baseUrl ?? ''}
          />
        </div>
      )}
    </div>
  )
}

// --- Test Configuration ---

function TestConfig({ page, project, onBriefingChange }: {
  page: DocPageDTO
  project: ProjectDTO
  onBriefingChange: (briefing: DocPageDTO['briefing']) => void
}): React.ReactElement {
  const briefing = page.briefing as Record<string, unknown> | null
  const testUrl = (briefing?.testUrl as string) ?? ''
  const testNotes = (briefing?.testNotes as string) ?? ''
  const projectResources = project.resources ?? []
  const selectedResources = (briefing?.selectedResources as number[]) ?? []

  const update = (field: string, value: unknown): void => {
    onBriefingChange({ ...(page.briefing ?? {}), [field]: value } as typeof page.briefing)
  }

  const toggleResource = (index: number): void => {
    const next = selectedResources.includes(index)
      ? selectedResources.filter((i) => i !== index)
      : [...selectedResources, index]
    update('selectedResources', next)
  }

  return (
    <div className={styles.section} style={{ marginBottom: 'var(--space-md)' }}>
      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-fg)', marginBottom: 'var(--space-md)' }}>
        Test Configuration
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <div>
          <label className={styles.briefingFieldLabel}>Test URL</label>
          <input type="text"
            value={testUrl || page.startUrl || project.baseUrl || ''}
            onChange={(e) => update('testUrl', e.target.value)}
            placeholder={page.startUrl ?? project.baseUrl ?? 'https://...'}
            className={styles.briefingInput}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
          />
        </div>
        <div>
          <label className={styles.briefingFieldLabel}>Additional context</label>
          <textarea
            value={testNotes}
            onChange={(e) => update('testNotes', e.target.value)}
            placeholder="e.g. Test with an expired subscription. The Reset button should show a confirmation dialog."
            rows={2} className={styles.briefingTextarea}
          />
        </div>

        {/* Project resources — checkboxes to select which ones to use */}
        <div>
          <label className={styles.briefingFieldLabel} style={{ margin: 0 }}>Resources</label>
          {projectResources.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', marginTop: 'var(--space-xs)' }}>
              {projectResources.map((r, i) => (
                <label key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
                  padding: '6px 8px', background: 'var(--color-secondary)', borderRadius: 'var(--radius-md)',
                  fontSize: 'var(--text-xs)', cursor: 'pointer',
                  border: selectedResources.includes(i) ? '1px solid var(--color-primary)' : '1px solid transparent',
                }}>
                  <input type="checkbox" checked={selectedResources.includes(i)}
                    onChange={() => toggleResource(i)}
                    style={{ accentColor: 'var(--color-primary)' }} />
                  <span style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase', fontSize: '10px', color: 'var(--color-muted-fg)' }}>{r.type}</span>
                  <span style={{ color: 'var(--color-fg)' }}>{r.label || r.value.split('/').pop()}</span>
                </label>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', fontStyle: 'italic', margin: 'var(--space-xs) 0 0' }}>
              No resources configured. Add files, URLs, or notes in Project Settings.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

