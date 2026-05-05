import { useEffect, useRef, useState } from 'react'
import { Button, Spinner, ProgressLoader } from '../../../design-system/components/index.js'
import { api, ApiError } from '../../../shared/api/client.js'
import { fetchMarketingVideo } from '../../../shared/api/db.js'
import type { MarketingVideoSummaryDTO } from '../../../shared/api/client.js'
import { useJobs } from '../../../shared/jobs/JobContext.js'
import styles from './MarketingVideoPanel.module.css'

interface MarketingVideoPanelProps {
  /** Latest run for this page, if any. When null, the panel runs in
   *  "page-only" mode: no screenshots, mocks visualMode forced, and a
   *  stub run is auto-created server-side on the first Generate click
   *  so the marketing-video pipeline (which is run-scoped) has a
   *  container to write the manifest to. */
  runId: string | null
  /** Required so the global JobTracker (bottom-right floating panel) can
   *  link the in-progress card back to this page. */
  pageId: string
  pageTitle: string
  /** Used to seed the stub run when runId is null — the run table needs
   *  a startUrl + goal even though the marketing pipeline doesn't read
   *  them. Page.startUrl with the project base URL as fallback. */
  fallbackStartUrl: string
}

type VoiceTone =
  | 'punchy' | 'calm' | 'playful' | 'serious'
  | 'confident' | 'inspirational' | 'conversational'
type VisualMode = 'screenshots' | 'mocks'

const TONE_LABELS: Record<VoiceTone, string> = {
  punchy:         'Punchy — energetic, marketing default',
  calm:           'Calm — measured, professional',
  playful:        'Playful — expressive, casual',
  serious:        'Serious — authoritative, monotone',
  confident:      'Confident — warm authority, founder pitch',
  inspirational: 'Inspirational — uplifting, building energy',
  conversational:'Conversational — natural, podcast-style',
}


/**
 * In-app surface for the marketing-video feature. One button, one
 * pipeline:
 *
 *   Pick options → click "Generate" → backend chains
 *     1. Gemini writes the script (and the audio tags inside the voice-over)
 *     2. ElevenLabs synthesizes the voice-over
 *     3. Optional: ElevenLabs Music composes a background track
 *     4. Video-service renders the final MP4
 *
 * The four steps run inside two HTTP calls (steps 1-3 in /marketing-video,
 * step 4 in /marketing-video/render). The UI shows them as four distinct
 * bullets so the user sees what's happening rather than staring at a
 * monolithic spinner.
 *
 * Re-clicking the button re-runs the whole chain — simpler than the
 * previous "regenerate script" / "update voice-over" / "render" trio
 * which made the user think about pipeline stages they shouldn't care
 * about.
 */
export function MarketingVideoPanel({ runId: initialRunId, pageId, pageTitle, fallbackStartUrl }: MarketingVideoPanelProps): React.ReactElement {
  const { jobs, addJob, failJob } = useJobs()
  // We may transition from no-run → run after the user clicks Generate
  // for the first time (auto-stub creation). Track it locally so all
  // subsequent calls (job tracking, refetch, regenerate) reuse the same
  // run instead of stubbing a new one each time.
  const [runId, setRunId] = useState<string | null>(initialRunId)
  // Resync if the parent ever passes a fresh runId (e.g. after the user
  // uploads a video on the same page in another tab).
  useEffect(() => { if (initialRunId) setRunId(initialRunId) }, [initialRunId])

  const [summary, setSummary] = useState<MarketingVideoSummaryDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [userPrompt, setUserPrompt] = useState('')
  const [withVoiceover, setWithVoiceover] = useState(true)
  const [voiceId, setVoiceId] = useState<string>('')
  const [tone, setTone] = useState<VoiceTone>('punchy')
  // No run = no screenshots = mocks-only. Lock the option in that case.
  const [visualMode, setVisualMode] = useState<VisualMode>(initialRunId ? 'screenshots' : 'mocks')
  const [voices, setVoices] = useState<Array<{ voiceId: string; name: string; category: string }>>([])
  const [musicPresets, setMusicPresets] = useState<Array<{ id: string; name: string; mood?: string }>>([])
  // Default to AI-generated cinematic music — most marketing videos
  // benefit from a backing track, and 'none' was a footgun: the user
  // hits Generate without touching the dropdown and gets a silent video,
  // then every subsequent refine preserves musicUrl: null via the
  // updateMarketingManifestForRun spread. Users who explicitly want
  // silence can still pick 'none' from the dropdown.
  const [musicChoice, setMusicChoice] = useState<string>('ai-cinematic')
  const [musicUploadPath, setMusicUploadPath] = useState<string | null>(null)
  const [musicUploadName, setMusicUploadName] = useState<string | null>(null)
  const [musicUploading, setMusicUploading] = useState(false)
  const [musicVolume, setMusicVolume] = useState(0.15)
  const [aiMusicPrompt, setAiMusicPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)

  // AI-driven manifest edit: chat-style refinement on top of an existing
  // manifest. `editHistory` keeps the conversation so Gemini sees the
  // context of earlier edits in this session.
  const [editHistory, setEditHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [editInput, setEditInput] = useState('')
  const [editing, setEditing] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // The summary read (Supabase direct, ~50-200ms) and the music presets
    // (in-memory constant) are both fast; the ElevenLabs voices call can
    // take 1-3s on a cold path. Don't gate the whole panel on it — fire
    // the fast pair first, render the form, and let voices stream in.
    void (async () => {
      try {
        const [result, presetsResult] = await Promise.all([
          runId ? fetchMarketingVideo(runId) : Promise.resolve(null),
          api.runs.marketingVideo.musicPresets().catch(() => ({ presets: [] })),
        ])
        if (!cancelled) {
          setSummary(result)
          setMusicPresets(presetsResult.presets)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message)
          setLoading(false)
        }
      }
    })()
    // Voices fire in parallel but don't block the form render — the voice
    // picker shows "Loading…" in its native disabled state until they land.
    void (async () => {
      try {
        const voicesResult = await api.runs.marketingVideo.voices()
        if (!cancelled) setVoices(voicesResult.voices)
      } catch {
        if (!cancelled) setVoices([])
      }
    })()
    return () => { cancelled = true }
  }, [runId])

  // When the marketing-video job for this run completes (via Realtime),
  // refetch the summary so the panel surfaces the fresh manifest + MP4.
  // Tracking by the job's status as it transitions to non-running.
  const ourJob = runId ? jobs.find((j) => j.runId === runId && j.type === 'marketing-video') : undefined
  const ourJobStatus = ourJob?.status
  useEffect(() => {
    if (!runId) return
    if (ourJobStatus !== 'completed' && ourJobStatus !== 'failed') return
    let cancelled = false
    void (async () => {
      try {
        const fresh = await fetchMarketingVideo(runId)
        if (!cancelled) setSummary(fresh)
      } catch { /* keep stale summary; banner will show if there was an error */ }
      // Refine loader is anchored on refineStartedAt; clear it now that
      // the job (generate or refine) has settled.
      if (!cancelled) setRefineStartedAt(null)
    })()
    return () => { cancelled = true }
  }, [runId, ourJobStatus])

  const handleMusicUpload = async (file: File): Promise<void> => {
    setError(null)
    if (!runId) {
      // The signed-upload-url helper writes under runs/:id/, so we need
      // a run to scope the upload. Pages without a video can still pick
      // AI-generated music or no music; tell the user the alternative.
      setError('Click Generate first to start a run, then come back to upload custom music — or pick AI-generated music instead.')
      return
    }
    setMusicUploading(true)
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'mp3'
      const path = `runs/${runId}/marketing-music.${ext}`
      const { signedUrl } = await api.runs.getSignedUploadUrl(runId, path)
      const uploadRes = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'audio/mpeg' },
        body: file,
      })
      if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`)
      setMusicUploadPath(path)
      setMusicUploadName(file.name)
      setMusicChoice('upload')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setMusicUploading(false)
    }
  }

  /**
   * Kick off the pipeline as a fire-and-forget background job. Returns
   * 202 in <1s; Vercel's `waitUntil` keeps the function alive past the
   * response so the 2-3 min pipeline completes server-side. Completion
   * arrives via Supabase Realtime on the jobs table (useJobRealtime
   * subscribes elsewhere) and useEffect below refetches the summary.
   *
   * The user can close the tab, navigate, refresh — work continues
   * server-side and the result is durable in storage + DB.
   */
  const handleGenerateAndRender = async (): Promise<void> => {
    setError(null)
    setWorking(true)

    const effUserPrompt = userPrompt.trim()
    const effTone = tone
    const effVisualMode = visualMode
    const effWithVoiceover = withVoiceover
    const effMusicChoice = musicChoice
    const effMusicVolume = musicVolume

    try {
      // No run on this page yet (manually-typed content, no video) —
      // auto-create a stub run so the marketing-video pipeline (which
      // is run-scoped) has a container. We do this BEFORE addJob so the
      // tracker card carries the real run id from frame 0.
      let activeRunId = runId
      if (!activeRunId) {
        const stub = await api.runs.create({
          featureName: `[Marketing] ${pageTitle}`,
          startUrl: fallbackStartUrl || 'https://example.com',
          goal: `Marketing video for ${pageTitle}`,
          docPageId: pageId,
        })
        activeRunId = stub.id
        setRunId(activeRunId)
      }

      addJob({ runId: activeRunId, pageId, pageTitle, type: 'marketing-video', status: 'running' })

      const musicOpts: {
        musicTrackId?: string
        musicUploadPath?: string
        musicVolume?: number
        aiMusicPrompt?: string
      } = {}
      if (effMusicChoice === 'upload' && musicUploadPath) {
        musicOpts.musicUploadPath = musicUploadPath
        musicOpts.musicVolume = effMusicVolume
      } else if (effMusicChoice === 'ai' || effMusicChoice.startsWith('ai-')) {
        musicOpts.musicTrackId = effMusicChoice
        musicOpts.musicVolume = effMusicVolume
        if (aiMusicPrompt.trim()) musicOpts.aiMusicPrompt = aiMusicPrompt.trim()
      } else if (effMusicChoice !== 'none' && effMusicChoice !== 'upload') {
        musicOpts.musicTrackId = effMusicChoice
        musicOpts.musicVolume = effMusicVolume
      }

      await api.runs.marketingVideo.generate(activeRunId, {
        userPrompt: effUserPrompt || undefined,
        withVoiceover: effWithVoiceover,
        voiceId: voiceId || undefined,
        tone: effTone,
        visualMode: effVisualMode,
        ...musicOpts,
      })
    } catch (err) {
      // Synchronous-side failures: validation errors (400), already-
      // running conflict (409), backend not reachable. Pipeline-side
      // failures arrive via Realtime → useJobRealtime later.
      const message = err instanceof ApiError ? err.message : (err as Error).message
      setError(message)
      // Mark the job failed if we'd already created one. If the stub-run
      // create itself threw before addJob, there's nothing to fail.
      if (runId) failJob(runId, message, err instanceof ApiError ? err.code ?? null : null)
    } finally {
      // Free the form quickly — user can adjust options for the next
      // run while this one is still finishing in the background.
      setWorking(false)
    }
  }


  // Render only — re-runs the Remotion render against the current
  // manifest WITHOUT re-doing Gemini script + ElevenLabs voice + music.
  // Cheap (~render cost only) and fast (2-5min). Used after an AI edit
  // to apply the new manifest without burning the full pipeline.
  const [rerendering, setRerendering] = useState(false)
  // Stable timestamp for the refine + auto-render ProgressLoader. Set
  // when the user fires a refine; cleared when the chained render
  // completes (so the next refine starts a fresh elapsed counter).
  const [refineStartedAt, setRefineStartedAt] = useState<number | null>(null)

  // Capture a thumbnail at ~4s from the rendered video, once. Used as the
  // poster on the player AND the og:image / social preview when the doc
  // page is shared. The 4s mark sits at the end of the hook with the
  // headline locked in — the punchiest frame in the video.
  const videoElementRef = useRef<HTMLVideoElement | null>(null)
  const thumbnailCapturedRef = useRef<string | null>(null) // tracks which videoUrl we already captured
  useEffect(() => {
    if (!runId) return
    if (!summary?.videoUrl) return
    // Skip if the manifest already has a thumbnail OR we already tried
    // for this exact videoUrl (prevent re-capture loops on re-renders).
    if (summary.manifest.thumbnailUrl) return
    if (thumbnailCapturedRef.current === summary.videoUrl) return

    let cancelled = false
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.src = summary.videoUrl
    video.muted = true
    video.preload = 'metadata'

    const cleanup = () => {
      video.pause()
      video.src = ''
      video.load()
    }

    video.addEventListener('loadeddata', () => {
      if (cancelled) return
      // Seek to 4s; the 'seeked' event fires once the frame is decoded.
      video.currentTime = Math.min(4, video.duration - 0.5)
    })

    video.addEventListener('seeked', () => {
      if (cancelled) return
      try {
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) return cleanup()
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
        thumbnailCapturedRef.current = summary.videoUrl ?? null
        // Fire-and-forget upload. Failure is silent — the poster just
        // stays empty until next time.
        api.runs.marketingVideo.uploadThumbnail(runId, dataUrl).then((result) => {
          if (cancelled) return
          // Patch the local summary so the poster shows immediately
          // without a refetch.
          setSummary((prev) => prev
            ? { ...prev, manifest: { ...prev.manifest, thumbnailUrl: result.thumbnailUrl, thumbnailPath: result.thumbnailPath } }
            : prev,
          )
        }).catch((err) => {
          console.warn('[marketing] thumbnail upload failed:', err)
        }).finally(() => {
          cleanup()
        })
      } catch (err) {
        // Cross-origin canvas taint will throw. Storage is on Supabase
        // with permissive CORS, so this should be rare in practice.
        console.warn('[marketing] thumbnail capture failed:', err)
        cleanup()
      }
    })

    video.addEventListener('error', () => cleanup())
    video.load()

    return () => { cancelled = true; cleanup() }
  }, [runId, summary?.videoUrl, summary?.manifest.thumbnailUrl])

  const handleRerenderOnly = async (): Promise<void> => {
    if (!runId || rerendering) return
    setRerendering(true)
    setError(null)
    try {
      const fresh = await api.runs.marketingVideo.render(runId)
      setSummary(fresh)
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message
      setError(message)
    } finally {
      setRerendering(false)
    }
  }

  // AI-driven manifest refinement. Fires the edit + render as a single
  // background job (same pattern as the initial generate): server returns
  // 202 + jobId immediately, the actual edit-then-render runs in
  // waitUntil, and the frontend listens via useJobs realtime to flip the
  // ProgressLoader off when the job completes (a useEffect below
  // re-fetches the marketing summary on the running → completed
  // transition). Survives Vercel's 300s cap and tab close.
  const handleEditWithAi = async (): Promise<void> => {
    const instruction = editInput.trim()
    if (!instruction || editing || !runId) return
    setEditError(null)
    // Optimistic: push the user message immediately so the chat feels
    // responsive even before the request returns. We don't push an
    // assistant message — the response is whatever the user sees in the
    // re-rendered video.
    const nextHistory = [...editHistory, { role: 'user' as const, content: instruction }]
    setEditHistory(nextHistory)
    setEditInput('')
    setEditing(true)
    setRefineStartedAt(Date.now())
    try {
      await api.runs.marketingVideo.editWithAi(runId, {
        instruction,
        history: editHistory,
      })
      // Job is created + accepted (202 returned). Optimistically register
      // it in the local JobContext so the loader keeps showing without
      // waiting for the realtime broadcast to land — that broadcast can
      // take 1-3s, and during the gap `editing === false` AND
      // `ourJob === undefined` made the loader vanish, which read as
      // "the refine is done already" and led users to click again →
      // 409 JOB_ALREADY_RUNNING. Adding the job locally bridges the gap;
      // realtime reconciles by id when it arrives.
      addJob({ runId, pageId, pageTitle, type: 'marketing-video', status: 'running' })
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message
      setEditError(message)
      // Roll back the optimistic user message so the input doesn't show
      // an unanswered prompt — the failure is surfaced via editError.
      setEditHistory(editHistory)
    } finally {
      setEditing(false)
      // refineStartedAt stays set — we want the elapsed counter on the
      // loader to keep climbing across the refine + render. It's reset
      // when ourJob completes (see ourJobStatus effect below).
    }
  }

  if (loading) {
    return (
      <div className={styles.container}>
        <Spinner size="md" />
      </div>
    )
  }

  const hasManifest = summary !== null
  const renderStatus = summary?.renderStatus ?? 'idle'

  // Form-wide lockout. The whole tab freezes during any operation that
  // produces a new render (full pipeline, AI refine, or auto-render
  // chained after a refine) so the user can't queue conflicting edits
  // mid-flight — the manifest would race with itself.
  const formLocked =
    working || ourJob?.status === 'running' || editing || rerendering

  // Distinct from formLocked: should the blue progress loader be shown?
  // Yes for the full pipeline AND for refine + auto-render chains.
  const showProgress = ourJob?.status === 'running' || editing || rerendering

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.eyebrow}>Marketing video</span>
        <p className={styles.subtitle}>
          A 45-second promo generated from this page — separate from the walkthrough.
        </p>
      </div>

      {error && <div className={`${styles.statusBanner} ${styles.statusError}`}>{error}</div>}

      {summary?.manifest.musicError && !working && (
        <div className={`${styles.statusBanner} ${styles.statusInfo}`}>
          Music skipped: {summary.manifest.musicError} — your voice-over was saved and the video still rendered.
        </div>
      )}

      {/* Two-column when there's a preview (running pipeline or rendered video):
       *  form on the left, preview on the right. Otherwise the form gets the
       *  whole row — no awkward empty right column on first visit. */}
      <div
        className={`${styles.layout} ${
          (showProgress || (hasManifest && summary && !working))
            ? styles.layoutWithPreview
            : ''
        }`}
      >
        <div className={styles.formColumn}>

      {/* === Brief === */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <span className={styles.cardTitle}>Creative brief</span>
          <p className={styles.cardDescription}>
            Tell the AI what angle to take. Skip if the doc speaks for itself.
          </p>
        </div>
        <textarea
          id="marketing-brief"
          className={styles.briefTextarea}
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value)}
          placeholder="e.g. Focus on the AI agent. Audience: B2B PMs. Tone: confident, slightly cheeky."
          maxLength={800}
          disabled={formLocked}
        />
      </div>

      {/* === Visual style === */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <span className={styles.cardTitle}>Visual style</span>
          <p className={styles.cardDescription}>
            {runId
              ? 'Real screenshots ground the video in your product. Designed mocks look more polished but less specific.'
              : 'Record a video first to unlock real screenshots — for now, the AI generates designed mocks.'}
          </p>
        </div>
        <div className={styles.radioRow} role="radiogroup">
          {([
            { id: 'screenshots' as const, title: 'Real screenshots', subtitle: 'Grounded in your product UI' },
            { id: 'mocks' as const,       title: 'Designed mocks',    subtitle: 'AI-designed animated panels' },
          ]).map((opt) => {
            const selected = visualMode === opt.id
            const optDisabled = formLocked || (opt.id === 'screenshots' && !runId)
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => { if (!optDisabled) setVisualMode(opt.id) }}
                disabled={optDisabled}
                className={`${styles.radioCard} ${selected ? styles.radioCardSelected : ''}`}
              >
                <span className={styles.radioCardTitle}>{opt.title}</span>
                <span className={styles.radioCardSubtitle}>{opt.subtitle}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* === Voice-over === */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <span className={styles.cardTitle}>Voice-over</span>
          <p className={styles.cardDescription}>
            ElevenLabs synthesizes a narration from the script. Disable to keep the video silent.
          </p>
        </div>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={withVoiceover}
            onChange={(e) => setWithVoiceover(e.target.checked)}
            disabled={formLocked}
          />
          Generate AI voice narration
        </label>

        {withVoiceover && (
          <div className={styles.fieldGrid}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Voice</span>
              <select
                className={styles.select}
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                disabled={formLocked || voices.length === 0}
              >
                <option value="">
                  {voices.length === 0 ? 'Loading voices…' : 'Default — Sarah (clear, professional)'}
                </option>
                {voices.map((v) => (
                  <option key={v.voiceId} value={v.voiceId}>
                    {v.name}{v.category ? ` · ${v.category}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Tone</span>
              <select
                className={styles.select}
                value={tone}
                onChange={(e) => setTone(e.target.value as VoiceTone)}
                disabled={formLocked}
              >
                {(Object.keys(TONE_LABELS) as VoiceTone[]).map((t) => (
                  <option key={t} value={t}>{TONE_LABELS[t]}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* === Music === */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <span className={styles.cardTitle}>Background music</span>
          <p className={styles.cardDescription}>
            Optional soundtrack mixed under the voice-over. Pick a preset, generate one with AI, or upload your own.
          </p>
        </div>
        <div className={musicChoice === 'none' ? '' : styles.fieldGrid}>
          <select
            className={styles.select}
            value={musicChoice}
            onChange={(e) => setMusicChoice(e.target.value)}
            disabled={formLocked}
          >
            <option value="none">None — voice-over only</option>
            {musicPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.mood ? ` · ${p.mood}` : ''}
              </option>
            ))}
            <option value="ai">Generate AI music</option>
            <option value="upload">Upload custom MP3…</option>
          </select>
          {musicChoice !== 'none' && (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Volume {Math.round(musicVolume * 100)}%</span>
              <input
                type="range"
                min={0}
                max={0.5}
                step={0.01}
                value={musicVolume}
                onChange={(e) => setMusicVolume(parseFloat(e.target.value))}
                disabled={formLocked}
                title="0–50% — kept low so the voice-over stays audible"
                className={styles.volumeSlider}
              />
            </div>
          )}
        </div>

        {(musicChoice === 'ai' || musicChoice.startsWith('ai-')) && (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>
              Music style <span className={styles.fieldHint}>optional · fine-tunes the AI prompt</span>
            </span>
            <input
              type="text"
              className={styles.textInput}
              value={aiMusicPrompt}
              onChange={(e) => setAiMusicPrompt(e.target.value)}
              placeholder="e.g. trap drums and synth bass / minimal piano, no drums"
              maxLength={300}
              disabled={formLocked}
            />
          </div>
        )}

        {musicChoice === 'upload' && (
          <div className={styles.uploadRow}>
            <input
              type="file"
              accept="audio/mpeg,audio/mp3,audio/wav,audio/x-m4a"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleMusicUpload(file)
              }}
              disabled={musicUploading || formLocked}
            />
            {musicUploading && <Spinner size="sm" />}
            {musicUploadName && !musicUploading && <span className={styles.uploadOk}>✓ {musicUploadName}</span>}
          </div>
        )}
      </div>

      {/* === Footer / generate ===
       *  Distinct from the cards above — sits as a clear "this is what
       *  you're about to do" panel with a one-line summary of the
       *  current selection above the primary CTA. Stripe Checkout
       *  pattern: the user reads what they're confirming before
       *  clicking. */}
      <div className={styles.footer}>
        <p className={styles.footerSummary}>
          Generates a 45-second{' '}
          <strong>{visualMode === 'screenshots' ? 'screenshot-based' : 'designed-mock'}</strong>{' '}
          video
          {withVoiceover ? <> with a <strong>{TONE_LABELS[tone].split(' ')[0]?.toLowerCase()}</strong> voice-over</> : <> (no voice-over)</>}
          {musicChoice === 'none'
            ? ''
            : musicChoice === 'ai'
              ? ' and AI-generated music'
              : musicChoice === 'upload'
                ? ' and your uploaded music'
                : ` and the ${musicPresets.find((p) => p.id === musicChoice)?.name ?? 'selected'} preset`}
          .
        </p>
        <div className={styles.actions}>
          <Button
            variant="primary"
            onClick={() => void handleGenerateAndRender()}
            disabled={formLocked || (musicChoice === 'upload' && !musicUploadPath)}
          >
            {showProgress ? 'Generating…' : hasManifest ? 'Regenerate video' : 'Generate marketing video'}
          </Button>
        </div>
      </div>
        </div>{/* /formColumn */}

      {/* === Preview column === */}
      {(showProgress || (hasManifest && summary && !working)) && (
        <div className={styles.previewColumn}>

      {/* === Pipeline progress (during full pipeline) === */}
      {ourJob?.status === 'running' && (
        <ProgressLoader
          startedAt={ourJob.startedAt}
          steps={[
            { label: 'Writing the script', estimatedSeconds: 30 },
            { label: 'Synthesizing voice-over', estimatedSeconds: withVoiceover ? 25 : 1 },
            { label: 'Composing music', estimatedSeconds: (musicChoice === 'ai' || musicChoice.startsWith('ai-')) ? 45 : 1 },
            { label: 'Rendering the video', estimatedSeconds: 80 },
          ]}
          activeStep={0}
          done={false}
        />
      )}

      {/* === Refine + auto-render progress === */}
      {ourJob?.status !== 'running' && (editing || rerendering) && (
        <ProgressLoader
          startedAt={refineStartedAt ?? Date.now()}
          steps={[
            { label: 'Updating the manifest', estimatedSeconds: 10 },
            { label: 'Rendering the video', estimatedSeconds: 80 },
          ]}
          activeStep={editing ? 0 : 1}
          done={false}
        />
      )}

      {/* === Result (after) === */}
      {hasManifest && summary && !working && ourJob?.status !== 'running' && (
        <div className={styles.resultBlock}>
          {/* The video stays visible across edits — even when renderStatus
            *  flipped back to 'idle' (manifest changed, no fresh render).
            *  The banner below tells the user the preview is stale. */}
          {summary.videoUrl && (renderStatus === 'ready' || renderStatus === 'idle') && (
            <video
              ref={videoElementRef}
              className={styles.videoPlayer}
              controls
              src={summary.videoUrl}
              preload="metadata"
              poster={summary.manifest.thumbnailUrl ?? undefined}
            />
          )}

          {/* Voice-over standalone player — kept as a fallback so the user
            *  can verify the synth output independently from the rendered
            *  video. Useful when the video is still rendering, when the
            *  caller wants to spot-check the voice/tone before iterating,
            *  or when the MP4 mux has any issue and the voice-over MP3
            *  itself is the source of truth for "is the audio right". */}
          {summary.manifest.voiceoverUrl && (
            <audio
              className={styles.audioPlayer}
              controls
              src={summary.manifest.voiceoverUrl}
              preload="metadata"
            />
          )}

          {/* Stale banner only shows when no auto-render is running — the
            *  ProgressLoader above already conveys the in-flight state
            *  for refines and full pipelines. The manual retry button
            *  remains as a fallback if an auto-render previously failed. */}
          {summary.videoUrl && renderStatus === 'idle' && !rerendering && !editing && (
            <div className={styles.staleBanner}>
              <span className={styles.staleBannerText}>
                Preview is from before your last edit.
              </span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleRerenderOnly()}
              >
                Re-render now
              </Button>
            </div>
          )}

          {summary.videoUrl && renderStatus === 'ready' && (
            <div className={styles.actions}>
              <a href={summary.videoUrl} download="marketing.mp4" className={styles.downloadLink}>
                Download MP4
              </a>
            </div>
          )}

          {renderStatus === 'failed' && summary.renderError && (
            <div className={`${styles.statusBanner} ${styles.statusError}`}>
              Render failed: {summary.renderError}
            </div>
          )}

          {/* === Refine with AI ===
            *  Chat-style manifest edits on top of the rendered video.
            *  Tell the AI what to change in plain language; the server
            *  validates the proposed manifest, persists it, and resets
            *  render status so the next render uses the new version. */}
          <div className={styles.refine}>
            <span className={styles.fieldLabel}>Refine with AI</span>
            <p className={styles.refineHint}>
              Describe a change in plain language. We'll update the manifest and
              re-render automatically. Voice-over stays the same — change it from
              the Voice section above.
            </p>

            {editHistory.length > 0 && (
              <div className={styles.refineHistory}>
                {editHistory.map((m, i) => (
                  <div
                    key={i}
                    className={m.role === 'user' ? styles.refineMsgUser : styles.refineMsgAssistant}
                  >
                    {m.content}
                  </div>
                ))}
                {editing && (
                  <div className={styles.refineMsgAssistant}>
                    <span className={styles.refineThinking}>Updating manifest…</span>
                  </div>
                )}
              </div>
            )}

            {editError && (
              <div className={`${styles.statusBanner} ${styles.statusError}`}>{editError}</div>
            )}

            <div className={styles.refineInputWrap}>
              <textarea
                className={styles.refineInput}
                value={editInput}
                onChange={(e) => setEditInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void handleEditWithAi()
                  }
                }}
                placeholder='e.g. "shorten scene 2 by 2 seconds and make it punchier"'
                rows={2}
                disabled={formLocked}
              />
              <button
                className={styles.refineSend}
                onClick={() => void handleEditWithAi()}
                disabled={!editInput.trim() || formLocked}
                aria-label="Send"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
        </div>
      )}
      </div>
    </div>
  )
}

