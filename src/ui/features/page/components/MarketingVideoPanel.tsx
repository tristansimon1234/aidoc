import { useEffect, useState } from 'react'
import { Button, Spinner, Badge } from '../../../design-system/components/index.js'
import { api, ApiError } from '../../../shared/api/client.js'
import type { MarketingVideoSummaryDTO } from '../../../shared/api/client.js'
import { useJobs } from '../../../shared/jobs/JobContext.js'
import styles from './MarketingVideoPanel.module.css'

interface MarketingVideoPanelProps {
  runId: string
  /** Required so the global JobTracker (bottom-right floating panel) can
   *  link the in-progress card back to this page. */
  pageId: string
  pageTitle: string
}

type VoiceTone = 'punchy' | 'calm' | 'playful' | 'serious'
type VisualMode = 'screenshots' | 'mocks'

const TONE_LABELS: Record<VoiceTone, string> = {
  punchy: 'Punchy — energetic, marketing default',
  calm: 'Calm — measured, professional',
  playful: 'Playful — expressive, casual',
  serious: 'Serious — authoritative, monotone',
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
export function MarketingVideoPanel({ runId, pageId, pageTitle }: MarketingVideoPanelProps): React.ReactElement {
  const { jobs, addJob, failJob } = useJobs()
  const [summary, setSummary] = useState<MarketingVideoSummaryDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [userPrompt, setUserPrompt] = useState('')
  const [withVoiceover, setWithVoiceover] = useState(true)
  const [voiceId, setVoiceId] = useState<string>('')
  const [tone, setTone] = useState<VoiceTone>('punchy')
  const [visualMode, setVisualMode] = useState<VisualMode>('screenshots')
  const [voices, setVoices] = useState<Array<{ voiceId: string; name: string; category: string }>>([])
  const [musicPresets, setMusicPresets] = useState<Array<{ id: string; name: string; mood?: string }>>([])
  const [musicChoice, setMusicChoice] = useState<string>('none')
  const [musicUploadPath, setMusicUploadPath] = useState<string | null>(null)
  const [musicUploadName, setMusicUploadName] = useState<string | null>(null)
  const [musicUploading, setMusicUploading] = useState(false)
  const [musicVolume, setMusicVolume] = useState(0.15)
  const [aiMusicPrompt, setAiMusicPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [result, voicesResult, presetsResult] = await Promise.all([
          api.runs.marketingVideo.get(runId),
          api.runs.marketingVideo.voices().catch(() => ({ voices: [] })),
          api.runs.marketingVideo.musicPresets().catch(() => ({ presets: [] })),
        ])
        if (!cancelled) {
          setSummary(result)
          setVoices(voicesResult.voices)
          setMusicPresets(presetsResult.presets)
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [runId])

  // When the marketing-video job for this run completes (via Realtime),
  // refetch the summary so the panel surfaces the fresh manifest + MP4.
  // Tracking by the job's status as it transitions to non-running.
  const ourJob = jobs.find((j) => j.runId === runId && j.type === 'marketing-video')
  const ourJobStatus = ourJob?.status
  useEffect(() => {
    if (ourJobStatus !== 'completed' && ourJobStatus !== 'failed') return
    let cancelled = false
    void (async () => {
      try {
        const fresh = await api.runs.marketingVideo.get(runId)
        if (!cancelled) setSummary(fresh)
      } catch { /* keep stale summary; banner will show if there was an error */ }
    })()
    return () => { cancelled = true }
  }, [runId, ourJobStatus])

  const handleMusicUpload = async (file: File): Promise<void> => {
    setError(null)
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
   * Kick off the full pipeline (script → voice → music → render) as
   * a background job on the server. Returns 202 in <1s, the heavy
   * lifting runs server-side, completion arrives via Supabase Realtime
   * on the jobs table — same pattern as doc-gen / voiceover / try-doc.
   *
   * The user can close the tab, navigate to another page, refresh —
   * the job survives. The bottom-right JobTracker card shows progress
   * from anywhere in the app.
   */
  const handleGenerateAndRender = async (): Promise<void> => {
    setError(null)
    setWorking(true)

    addJob({ runId, pageId, pageTitle, type: 'marketing-video', status: 'running' })

    try {
      const musicOpts: {
        musicTrackId?: string
        musicUploadPath?: string
        musicVolume?: number
        aiMusicPrompt?: string
      } = {}
      if (musicChoice === 'upload' && musicUploadPath) {
        musicOpts.musicUploadPath = musicUploadPath
        musicOpts.musicVolume = musicVolume
      } else if (musicChoice === 'ai') {
        musicOpts.musicTrackId = 'ai'
        musicOpts.musicVolume = musicVolume
        if (aiMusicPrompt.trim()) musicOpts.aiMusicPrompt = aiMusicPrompt.trim()
      } else if (musicChoice !== 'none' && musicChoice !== 'upload') {
        musicOpts.musicTrackId = musicChoice
        musicOpts.musicVolume = musicVolume
      }

      // Fire-and-forget: backend returns 202, runs the pipeline in
      // background, updates the jobs table when done. useJobRealtime
      // flips the JobTracker card to "ready" or shows the failure.
      await api.runs.marketingVideo.generate(runId, {
        userPrompt: userPrompt.trim() || undefined,
        withVoiceover,
        voiceId: voiceId || undefined,
        tone,
        visualMode,
        ...musicOpts,
      })
    } catch (err) {
      // Only the synchronous-side errors (validation, 409 already-running)
      // land here. Pipeline failures arrive via Realtime → useJobRealtime.
      const message = err instanceof ApiError ? err.message : (err as Error).message
      setError(message)
      failJob(runId, message, err instanceof ApiError ? err.code ?? null : null)
    } finally {
      // Re-enable the form quickly — the user can adjust options for the
      // next run while the current one finishes in the background.
      setWorking(false)
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

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>Marketing video</h2>
        <p className={styles.subtitle}>
          Turn this page into a 45-second marketing video. Pick your settings, click Generate — we handle the script, voice, music, and final MP4 in one pass.
        </p>
      </div>

      {error && <div className={`${styles.statusBanner} ${styles.statusError}`}>{error}</div>}

      {summary?.manifest.musicError && !working && (
        <div className={`${styles.statusBanner} ${styles.statusInfo}`}>
          Music skipped: {summary.manifest.musicError} — your script + voice-over were saved and the video still rendered. Pick "None" or upload your own MP3 to silence this warning.
        </div>
      )}

      <div className={styles.briefField}>
        <label className={styles.briefLabel} htmlFor="marketing-brief">Creative brief (optional)</label>
        <textarea
          id="marketing-brief"
          className={styles.briefTextarea}
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value)}
          placeholder="e.g. Focus on the AI agent. Audience: B2B PMs. Tone: confident, slightly cheeky."
          maxLength={800}
          disabled={working}
        />
      </div>

      <div className={styles.optionsRow}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={withVoiceover}
            onChange={(e) => setWithVoiceover(e.target.checked)}
            disabled={working}
          />
          Generate voice-over (~€0.30 / generation)
        </label>
      </div>

      {withVoiceover && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: voices.length > 0 ? '1fr 1fr' : '1fr',
            gap: 16,
            margin: '0 0 24px',
          }}
        >
          {voices.length > 0 && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)' }}>
              <span style={{ color: 'var(--color-muted-fg)' }}>Voice</span>
              <select
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                disabled={working}
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-bg)',
                  color: 'var(--color-fg)',
                  fontSize: 'var(--text-sm)',
                }}
              >
                <option value="">Default (Sarah — clear, professional)</option>
                {voices.map((v) => (
                  <option key={v.voiceId} value={v.voiceId}>
                    {v.name} {v.category ? `· ${v.category}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)' }}>
            <span style={{ color: 'var(--color-muted-fg)' }}>Tone</span>
            <select
              value={tone}
              onChange={(e) => setTone(e.target.value as VoiceTone)}
              disabled={working}
              style={{
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border)',
                background: 'var(--color-bg)',
                color: 'var(--color-fg)',
                fontSize: 'var(--text-sm)',
              }}
            >
              {(Object.keys(TONE_LABELS) as VoiceTone[]).map((t) => (
                <option key={t} value={t}>{TONE_LABELS[t]}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div style={{ margin: '0 0 24px' }}>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)', marginBottom: 8 }}>
          Visual style
        </div>
        <div role="radiogroup" style={{ display: 'flex', gap: 8 }}>
          {([
            { id: 'screenshots' as const, title: 'Real screenshots', subtitle: 'Grounded in your product UI' },
            { id: 'mocks' as const,       title: 'Designed mocks',    subtitle: 'AI-designed animated UI panels' },
          ]).map((opt) => {
            const selected = visualMode === opt.id
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setVisualMode(opt.id)}
                disabled={working}
                style={{
                  flex: 1,
                  padding: '12px 14px',
                  borderRadius: 'var(--radius-md)',
                  border: `1px solid ${selected ? 'var(--color-fg)' : 'var(--color-border)'}`,
                  background: selected ? 'var(--color-fg)' : 'transparent',
                  color: selected ? 'var(--color-bg)' : 'var(--color-fg)',
                  cursor: working ? 'not-allowed' : 'pointer',
                  textAlign: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  fontSize: 'var(--text-sm)',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
              >
                <span style={{ fontWeight: 600 }}>{opt.title}</span>
                <span style={{ fontSize: 'var(--text-xs)', opacity: 0.7 }}>{opt.subtitle}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: musicChoice === 'none' ? '1fr' : '2fr 1fr',
          gap: 16,
          margin: '0 0 24px',
          alignItems: 'end',
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)' }}>
          <span style={{ color: 'var(--color-muted-fg)' }}>Background music</span>
          <select
            value={musicChoice}
            onChange={(e) => setMusicChoice(e.target.value)}
            disabled={working}
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg)',
              color: 'var(--color-fg)',
              fontSize: 'var(--text-sm)',
            }}
          >
            <option value="none">None — voice-over only</option>
            {musicPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.mood ? ` · ${p.mood}` : ''}
              </option>
            ))}
            <option value="ai">Generate AI music (~30s extra, ~€0.10)</option>
            <option value="upload">Upload custom MP3…</option>
          </select>
        </label>
        {musicChoice !== 'none' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)' }}>
            <span style={{ color: 'var(--color-muted-fg)' }}>Volume {Math.round(musicVolume * 100)}%</span>
            <input
              type="range"
              min={0}
              max={0.5}
              step={0.01}
              value={musicVolume}
              onChange={(e) => setMusicVolume(parseFloat(e.target.value))}
              disabled={working}
              title="0–50% — kept low so the voice-over stays audible"
            />
          </label>
        )}
      </div>

      {musicChoice === 'ai' && (
        <div style={{ margin: '0 0 24px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)' }}>
            <span style={{ color: 'var(--color-muted-fg)' }}>
              Music style (optional) — base prompt is derived from your tone choice; this fine-tunes it.
            </span>
            <input
              type="text"
              value={aiMusicPrompt}
              onChange={(e) => setAiMusicPrompt(e.target.value)}
              placeholder="e.g. trap drums and synth bass / minimal piano, no drums"
              maxLength={300}
              disabled={working}
              style={{
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border)',
                background: 'var(--color-bg)',
                color: 'var(--color-fg)',
                fontSize: 'var(--text-sm)',
              }}
            />
          </label>
        </div>
      )}

      {musicChoice === 'upload' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            margin: '0 0 24px',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-muted-fg)',
          }}
        >
          <input
            type="file"
            accept="audio/mpeg,audio/mp3,audio/wav,audio/x-m4a"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleMusicUpload(file)
            }}
            disabled={musicUploading || working}
          />
          {musicUploading && <Spinner size="sm" />}
          {musicUploadName && !musicUploading && <span>✓ {musicUploadName}</span>}
        </div>
      )}

      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={handleGenerateAndRender}
          disabled={working || (musicChoice === 'upload' && !musicUploadPath)}
        >
          {working ? 'Generating…' : hasManifest ? 'Regenerate video' : 'Generate marketing video'}
        </Button>
      </div>

      {hasManifest && summary && !working && (
        <>
          <div className={styles.scriptCard}>
            <div className={styles.scriptSection}>
              <div className={styles.scriptLabel}>
                <span>Hook · {summary.manifest.script.hook.durationSeconds}s</span>
                <Badge color="purple">{summary.manifest.script.language}</Badge>
              </div>
              <h3 className={styles.scriptHeadline}>{summary.manifest.script.hook.headline}</h3>
              <p className={styles.scriptVoiceover}>"{summary.manifest.script.hook.voiceover}"</p>
            </div>

            {summary.manifest.script.scenes.map((scene, i) => (
              <div key={i} className={styles.scriptSection}>
                <div className={styles.scriptLabel}>
                  <span>Scene {i + 1} · {scene.durationSeconds}s</span>
                  {scene.screenshotIndex != null && <span>screenshot #{scene.screenshotIndex}</span>}
                </div>
                <h3 className={styles.scriptHeadline}>{scene.headline}</h3>
                {scene.subhead && <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)', margin: 0 }}>{scene.subhead}</p>}
                <p className={styles.scriptVoiceover}>"{scene.voiceover}"</p>
              </div>
            ))}

            <div className={styles.scriptSection}>
              <div className={styles.scriptLabel}>
                <span>CTA · {summary.manifest.script.cta.durationSeconds}s</span>
                <span>{summary.manifest.script.cta.buttonLabel}</span>
              </div>
              <h3 className={styles.scriptHeadline}>{summary.manifest.script.cta.headline}</h3>
              <p className={styles.scriptVoiceover}>"{summary.manifest.script.cta.voiceover}"</p>
            </div>

            {summary.manifest.voiceoverUrl && (
              <audio
                className={styles.audioPlayer}
                controls
                src={summary.manifest.voiceoverUrl}
                preload="metadata"
              />
            )}
          </div>

          {summary.videoUrl && renderStatus === 'ready' && (
            <video
              className={styles.videoPlayer}
              controls
              src={summary.videoUrl}
              preload="metadata"
            />
          )}

          <div className={styles.actions}>
            {summary.manifestUrl && (
              <a
                href={summary.manifestUrl}
                download={`marketing-manifest-${runId}.json`}
                title="Download the manifest JSON to render locally with `npm run remotion:render -- --props=<file>`"
                style={{
                  padding: '8px 16px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-fg)',
                  textDecoration: 'none',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 500,
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
              >
                Download manifest JSON
              </a>
            )}
            {summary.videoUrl && (
              <a
                href={summary.videoUrl}
                download="marketing.mp4"
                style={{
                  padding: '8px 16px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-fg)',
                  textDecoration: 'none',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 500,
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
              >
                Download MP4
              </a>
            )}
          </div>

          {renderStatus === 'failed' && summary.renderError && !working && (
            <div className={`${styles.statusBanner} ${styles.statusError}`}>
              Render failed: {summary.renderError}
              {summary.manifestUrl && (
                <>
                  {' '}— you can download the manifest above and render locally with{' '}
                  <code>npm run remotion:render -- --props=&lt;file&gt;</code>.
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

