import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useOutletContext, Link } from 'react-router-dom'
import {
  Button,
  Spinner,
  BlockEditor,
  EmptyState,
  TableOfContents,
  ProgressLoader,
} from '../../../design-system/components/index.js'
import { api, type DocPageDTO, type ProjectDTO, type StepEventDTO, type TryDocReportDTO } from '../../../shared/api/client.js'
import { fetchPageFull, updatePage as dbUpdatePage, fetchLatestTestReport } from '../../../shared/api/db.js'
import { supabase } from '../../../shared/api/supabase.js'
import { NarratedPlayer } from '../components/NarratedPlayer.js'
import { VideoTimeline } from '../components/VideoTimeline.js'
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
  const [videoDuration, setVideoDuration] = useState(0)
  const [latestRunId, setLatestRunId] = useState<string | null>(null)
  const [voices, setVoices] = useState<{ voiceId: string; name: string }[]>([])
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | undefined>(undefined)
  const [selectedTone, setSelectedTone] = useState<string>('friendly')
  const [generatingVoiceover, setGeneratingVoiceover] = useState(false)
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
    // Reset run-dependent state
    setVideoUrl(null)
    setVoiceoverUrl(null)
    setVoiceoverSegments([])
    setLatestRunId(null)
    setVideoDuration(0)
    setTryReport(null)
    setTryRunning(false)
    setAnalyzing(false)
    setTryStreamSteps([])
    setGeneratingVoiceover(false)
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
    const briefingData = page.briefing as Record<string, unknown> | null
    const testUrl = (briefingData?.testUrl as string) || page.startUrl || context.project.baseUrl
    const testNotes = (briefingData?.testNotes as string) || ''

    const tryDocPrompt = `You are simulating a NAIVE USER who has ONLY the documentation below. You have never used this product before. You know NOTHING about it except what the documentation tells you.

## Documentation to verify:

${page.content}
${testNotes ? `\n## Additional test context\n${testNotes}` : ''}

## Your task:
1. Navigate to: ${testUrl}
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
        startUrl: testUrl,
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

      {/* ===== DOCUMENTATION TAB ===== */}
      {activeTab === 'doc' && (
        <div className={styles.tabContent} style={{ maxWidth: '820px', margin: '0 auto' }}>
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
        <div className={styles.tabContent} style={{ maxWidth: '960px', margin: '0 auto' }}>
          {(videoUrl || latestRunId) ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
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
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', padding: '4px 8px', borderRadius: 'var(--radius-md)', transition: 'color 0.15s' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></svg>
                  Replace
                  <input type="file" accept="video/mp4,video/webm,video/quicktime" style={{ display: 'none' }} onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (!file || !latestRunId) return
                    void (async () => {
                      try {
                        const ext = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')) : '.mp4'
                        const path = `runs/${latestRunId}/video${ext}`
                        const { signedUrl } = await api.runs.getSignedUploadUrl(latestRunId, path)
                        const uploadRes = await fetch(signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
                        if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.statusText}`)
                        const publicUrl = supabase.storage.from('artifacts').getPublicUrl(path).data?.publicUrl
                        if (publicUrl) setVideoUrl(`${publicUrl}?t=${Date.now()}`)
                        setVoiceoverUrl(null)
                        setVoiceoverSegments([])
                        // Refresh to pick up new video path
                        await fetchData()
                      } catch (err) {
                        console.error('[replace] Failed:', (err as Error).message)
                      }
                    })()
                  }} />
                </label>

                {/* Publish toggle */}
                <div
                  className={styles.videoPublish}
                  onClick={() => {
                    const current = (page.briefing as Record<string, unknown> | null)?.showVideoOnPublic as boolean | undefined
                    const newVal = !current
                    const newBriefing = { ...(page.briefing ?? {}), showVideoOnPublic: newVal } as typeof page.briefing
                    setPage({ ...page, briefing: newBriefing })
                    void dbUpdatePage(projectId!, pageId!, { briefing: newBriefing })
                  }}
                >
                  <div className={`${styles.toggleTrack} ${(page.briefing as Record<string, unknown> | null)?.showVideoOnPublic ? styles.toggleTrackOn : ''}`}>
                    <div className={`${styles.toggleKnob} ${(page.briefing as Record<string, unknown> | null)?.showVideoOnPublic ? styles.toggleKnobOn : ''}`} />
                  </div>
                  <span style={{
                    fontSize: 'var(--text-xs)', fontWeight: 500,
                    color: (page.briefing as Record<string, unknown> | null)?.showVideoOnPublic ? 'var(--color-success)' : 'var(--color-muted-fg)',
                  }}>
                    {(page.briefing as Record<string, unknown> | null)?.showVideoOnPublic ? 'Published' : 'Hidden'}
                  </span>
                </div>
                {latestRunId && page.content && (
                  <Button size="sm" disabled={generatingVoiceover} onClick={() => {
                    void (async () => {
                      setGeneratingVoiceover(true)
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
                        // Re-fetch to ensure video URL is fresh (summary may have changed)
                        await fetchData()
                      } finally {
                        setGeneratingVoiceover(false)
                      }
                    })()
                  }}>
                    {voiceoverUrl ? 'Regenerate' : 'Generate voice-over'}
                  </Button>
                )}
              </div>

              {/* Generation progress */}
              {generatingVoiceover && (
                <ProgressLoader
                  steps={[
                    { label: 'Generating voice-over — analyzing video, writing script, synthesizing audio...', estimatedSeconds: 90 },
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: 0 }}>
                    <div title="Click any segment text to edit it, then press Enter or the refresh icon to regenerate just that segment. Drag the blue trim handles on the timeline to cut the video start/end." style={{ display: 'flex', alignItems: 'center', cursor: 'help', color: 'var(--color-muted-fg)' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
                    </div>
                  </div>
                </>
              )}
            </div>
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
          {/* Explanation */}
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)', margin: '0 0 var(--space-sm)', lineHeight: 1.6 }}>
            Record your screen or upload a video — the AI analyzes every action, extracts key screenshots, and generates structured documentation automatically.
          </p>
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 'var(--space-sm)',
            padding: 'var(--space-sm) var(--space-md)',
            background: 'var(--color-status-running-bg)',
            border: '1px solid var(--color-status-running-border)',
            borderRadius: 'var(--radius-lg)',
            marginBottom: 'var(--space-lg)',
            fontSize: 'var(--text-xs)', color: 'var(--color-status-running-text)', lineHeight: 1.5,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
            <span>
              <strong>Tip:</strong> For best results, narrate your actions while recording — describe what you&apos;re doing and why. The AI uses your voice to understand the context and generate better documentation.
            </span>
          </div>

          {/* Two-column layout: briefing + actions */}
          <div className={styles.generateGrid}>
            {/* Left — Briefing */}
            <div className={styles.section} style={{ margin: 0 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-fg)', marginBottom: 'var(--space-md)' }}>
                Briefing
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                <div>
                  <label className={styles.briefingFieldLabel}>Goal</label>
                  <input type="text" value={page.goal ?? ''} onChange={(e) => {
                    setPage({ ...page, goal: e.target.value })
                    void debouncedPageUpdate({ goal: e.target.value })
                  }} placeholder="e.g. Document the pricing and upgrade flow" className={styles.briefingInput} />
                </div>

                <div>
                  <label className={styles.briefingFieldLabel}>What to document</label>
                  <textarea
                    value={(page.briefing as Record<string, unknown> | null)?.objective as string ?? ''}
                    onChange={(e) => {
                      const newBriefing = { ...(page.briefing ?? {}), objective: e.target.value } as typeof page.briefing
                      setPage({ ...page, briefing: newBriefing })
                      void debouncedPageUpdate({ briefing: newBriefing })
                    }}
                    placeholder="e.g. Document how a new user creates an account and completes onboarding"
                    rows={2} className={styles.briefingTextarea}
                  />
                </div>

                <div>
                  <label className={styles.briefingFieldLabel}>What the agent can&apos;t see</label>
                  <textarea
                    value={(page.briefing as Record<string, unknown> | null)?.knowledge as string ?? ''}
                    onChange={(e) => {
                      const newBriefing = { ...(page.briefing ?? {}), knowledge: e.target.value } as typeof page.briefing
                      setPage({ ...page, briefing: newBriefing })
                      void debouncedPageUpdate({ briefing: newBriefing })
                    }}
                    placeholder="e.g. Free trial users can't access billing. Export only appears after 3 entries."
                    rows={2} className={styles.briefingTextarea}
                  />
                </div>
              </div>
            </div>

            {/* Right — Record / Upload */}
            <div>
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
            </div>
          </div>

          {error && <EmptyState title="Error" description={error} />}
        </div>
      )}

      {/* ===== TEST TAB ===== */}
      {activeTab === 'test' && (
        <div className={styles.tabContent}>
          {/* Not running — show config + run button or results */}
          {!tryRunning && !analyzing && (
            <>
              {/* Two-column: config + action */}
              <div className={styles.generateGrid}>
                {/* Left — Test configuration */}
                <TestConfig
                  page={page}
                  project={context.project}
                  pageId={pageId!}
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
                    {tryReport && (
                      <div style={{
                        padding: 'var(--space-sm) var(--space-md)', background: 'var(--color-secondary)',
                        borderRadius: 'var(--radius-md)', fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)',
                      }}>
                        Last tested {new Date(tryReport.executedAt).toLocaleDateString()} — {tryReport.summary.overallVerdict}
                      </div>
                    )}
                    <Button onClick={() => void handleTryDoc()} disabled={!page.content}>
                      {tryReport ? 'Re-test documentation' : 'Run test'}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Report below */}
              {tryReport && (
                <div style={{ marginTop: 'var(--space-md)' }}>
                  <TryDocReport report={tryReport} />
                </div>
              )}
            </>
          )}

          {/* Running — live browser + steps */}
          {tryRunning && (
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

          {/* Analyzing */}
          {analyzing && (
            <ProgressLoader
              steps={[{ label: 'Generating structured test report', estimatedSeconds: 20 }]}
              activeStep={0}
            />
          )}
        </div>
      )}
    </div>
  )
}

// --- Test Configuration ---

const TEST_FILE_EXTENSIONS = ['.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.xml', '.pdf']
const TEST_MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB

interface TestResource {
  type: 'url' | 'file' | 'note'
  label: string
  value: string
}

function TestConfig({ page, project, pageId, onBriefingChange }: {
  page: DocPageDTO
  project: ProjectDTO
  pageId: string
  onBriefingChange: (briefing: DocPageDTO['briefing']) => void
}): React.ReactElement {
  const briefing = page.briefing as Record<string, unknown> | null
  const testUrl = (briefing?.testUrl as string) ?? ''
  const testNotes = (briefing?.testNotes as string) ?? ''
  const testResources = (briefing?.testResources as TestResource[]) ?? []
  const [uploadError, setUploadError] = useState<string | null>(null)

  const update = (field: string, value: unknown): void => {
    onBriefingChange({ ...(page.briefing ?? {}), [field]: value } as typeof page.briefing)
  }

  const addResource = (): void => {
    update('testResources', [...testResources, { type: 'note', label: '', value: '' }])
  }

  const updateResource = (i: number, field: keyof TestResource, val: string): void => {
    update('testResources', testResources.map((r, j) => j === i ? { ...r, [field]: val } : r))
  }

  const removeResource = (i: number): void => {
    update('testResources', testResources.filter((_, j) => j !== i))
  }

  const handleFileUpload = async (i: number, e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadError(null)
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase()
    if (!TEST_FILE_EXTENSIONS.includes(ext)) { setUploadError(`Unsupported type. Accepted: ${TEST_FILE_EXTENSIONS.join(', ')}`); return }
    if (file.size > TEST_MAX_FILE_SIZE) { setUploadError('File too large (max 2MB)'); return }
    const path = `pages/${pageId}/test/${file.name}`
    const { error } = await supabase.storage.from('briefing-files').upload(path, file, { upsert: true })
    if (error) { setUploadError(`Upload failed: ${error.message}`); return }
    update('testResources', testResources.map((r, j) => j === i ? { ...r, value: path, label: r.label || file.name } : r))
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

        {/* Resources */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-sm)' }}>
            <label className={styles.briefingFieldLabel} style={{ margin: 0 }}>Resources</label>
            <button type="button" onClick={addResource} style={{
              background: 'none', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
              cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)',
              fontFamily: 'var(--font-mono)', padding: '2px 8px',
            }}>+ add</button>
          </div>
          {uploadError && <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-destructive)', margin: '0 0 var(--space-sm)' }}>{uploadError}</p>}
          {testResources.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 2fr auto', gap: 'var(--space-xs)', marginBottom: 'var(--space-xs)', alignItems: 'center' }}>
              <select value={r.type} onChange={(e) => updateResource(i, 'type', e.target.value)} style={{
                background: 'var(--color-secondary)', border: '1px solid transparent', borderRadius: 'var(--radius-md)',
                padding: '6px 8px', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)',
              }}>
                <option value="url">URL</option>
                <option value="file">File</option>
                <option value="note">Note</option>
              </select>
              <input type="text" value={r.label} onChange={(e) => updateResource(i, 'label', e.target.value)}
                placeholder="label" style={{
                  width: '100%', padding: '6px 8px', fontSize: 'var(--text-xs)', color: 'var(--color-fg)',
                  background: 'var(--color-secondary)', border: '1px solid transparent', borderRadius: 'var(--radius-md)',
                  fontFamily: 'var(--font-sans)', outline: 'none',
                }} />
              {r.type === 'file' ? (
                r.value ? (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', padding: '6px 8px' }}>{r.value.split('/').pop()}</span>
                ) : (
                  <input type="file" accept={TEST_FILE_EXTENSIONS.join(',')} onChange={(e) => void handleFileUpload(i, e)}
                    style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }} />
                )
              ) : (
                <input type="text" value={r.value} onChange={(e) => updateResource(i, 'value', e.target.value)}
                  placeholder={r.type === 'url' ? 'https://...' : 'info...'} style={{
                    width: '100%', padding: '6px 8px', fontSize: 'var(--text-xs)', color: 'var(--color-fg)',
                    background: 'var(--color-secondary)', border: '1px solid transparent', borderRadius: 'var(--radius-md)',
                    fontFamily: r.type === 'url' ? 'var(--font-mono)' : 'var(--font-sans)', outline: 'none',
                  }} />
              )}
              <button type="button" onClick={() => removeResource(i)} style={{
                background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xs)',
                color: 'var(--color-muted-fg)', padding: 4, borderRadius: 'var(--radius-sm)',
              }}>x</button>
            </div>
          ))}
          {testResources.length === 0 && (
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', fontStyle: 'italic', margin: 0 }}>
              No resources — add PDFs, URLs, or notes for the test agent.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

