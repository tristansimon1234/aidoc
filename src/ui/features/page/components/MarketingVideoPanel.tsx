import { useEffect, useState } from 'react'
import { Button, Spinner, Badge } from '../../../design-system/components/index.js'
import { api, ApiError } from '../../../shared/api/client.js'
import type { MarketingVideoSummaryDTO } from '../../../shared/api/client.js'
import styles from './MarketingVideoPanel.module.css'

interface MarketingVideoPanelProps {
  runId: string
}

type VoiceTone = 'punchy' | 'calm' | 'playful' | 'serious'

const TONE_LABELS: Record<VoiceTone, string> = {
  punchy: 'Punchy — energetic, marketing default',
  calm: 'Calm — measured, professional',
  playful: 'Playful — expressive, casual',
  serious: 'Serious — authoritative, monotone',
}

/**
 * In-app surface for the marketing-video feature. Three states it walks
 * the user through:
 *   1. Empty — no manifest yet. User writes a creative brief, hits Generate.
 *      Hits POST /marketing-video which calls Gemini + ElevenLabs.
 *   2. Manifest ready, no MP4 — script + voice-over in hand, ready to render.
 *      User can preview the script, listen to the narration, then hit Render.
 *      Hits POST /marketing-video/render which delegates to the video-service.
 *   3. Render done — embedded MP4 + download.
 *
 * Re-generating wipes the existing manifest (same endpoint, fresh Gemini
 * call). Re-rendering keeps the manifest and just swaps the MP4 — handy
 * after the user swaps a scene's headline by hand later.
 */
export function MarketingVideoPanel({ runId }: MarketingVideoPanelProps): React.ReactElement {
  const [summary, setSummary] = useState<MarketingVideoSummaryDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [userPrompt, setUserPrompt] = useState('')
  const [withVoiceover, setWithVoiceover] = useState(true)
  const [voiceId, setVoiceId] = useState<string>('')
  const [tone, setTone] = useState<VoiceTone>('punchy')
  const [voices, setVoices] = useState<Array<{ voiceId: string; name: string; category: string }>>([])
  const [musicPresets, setMusicPresets] = useState<Array<{ id: string; name: string; mood?: string }>>([])
  // 'none' (silent), '<presetId>' (bundled), or 'upload' (custom upload).
  const [musicChoice, setMusicChoice] = useState<string>('none')
  const [musicUploadPath, setMusicUploadPath] = useState<string | null>(null)
  const [musicUploadName, setMusicUploadName] = useState<string | null>(null)
  const [musicUploading, setMusicUploading] = useState(false)
  const [musicVolume, setMusicVolume] = useState(0.15)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [result, voicesResult, presetsResult] = await Promise.all([
          api.runs.marketingVideo.get(runId),
          // Voices fetch is best-effort: ElevenLabs may be unconfigured or
          // hit a transient error. UI falls back to the default voice silently.
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

  const handleGenerate = async (): Promise<void> => {
    setError(null)
    setGenerating(true)
    try {
      const musicOpts: { musicTrackId?: string; musicUploadPath?: string; musicVolume?: number } = {}
      if (musicChoice === 'upload' && musicUploadPath) {
        musicOpts.musicUploadPath = musicUploadPath
        musicOpts.musicVolume = musicVolume
      } else if (musicChoice !== 'none' && musicChoice !== 'upload') {
        musicOpts.musicTrackId = musicChoice
        musicOpts.musicVolume = musicVolume
      }
      const result = await api.runs.marketingVideo.generate(runId, {
        userPrompt: userPrompt.trim() || undefined,
        withVoiceover,
        voiceId: voiceId || undefined,
        tone,
        ...musicOpts,
      })
      setSummary(result)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  const handleRender = async (): Promise<void> => {
    setError(null)
    setRendering(true)
    try {
      const result = await api.runs.marketingVideo.render(runId)
      setSummary(result)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message)
    } finally {
      setRendering(false)
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
  const isRendering = rendering || renderStatus === 'rendering'

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>Marketing video</h2>
        <p className={styles.subtitle}>
          Turn this page into a 60s 16:9 marketing video. Gemini writes the script grounded in the doc, ElevenLabs voices it, Remotion renders it.
        </p>
      </div>

      {error && <div className={`${styles.statusBanner} ${styles.statusError}`}>{error}</div>}

      <div className={styles.briefField}>
        <label className={styles.briefLabel} htmlFor="marketing-brief">Creative brief (optional)</label>
        <textarea
          id="marketing-brief"
          className={styles.briefTextarea}
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value)}
          placeholder="e.g. Focus on the AI agent. Audience: B2B PMs. Tone: confident, slightly cheeky."
          maxLength={800}
          disabled={generating}
        />
      </div>

      <div className={styles.optionsRow}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={withVoiceover}
            onChange={(e) => setWithVoiceover(e.target.checked)}
            disabled={generating}
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
                disabled={generating}
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
              disabled={generating}
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
            disabled={generating}
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
              disabled={generating}
              title="0–50% — kept low so the voice-over stays audible"
            />
          </label>
        )}
      </div>

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
            disabled={musicUploading || generating}
          />
          {musicUploading && <Spinner size="sm" />}
          {musicUploadName && !musicUploading && <span>✓ {musicUploadName}</span>}
        </div>
      )}

      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={handleGenerate}
          disabled={generating || (musicChoice === 'upload' && !musicUploadPath)}
        >
          {generating ? 'Generating…' : hasManifest ? 'Regenerate script' : 'Generate marketing video'}
        </Button>
      </div>

      {hasManifest && summary && (
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

          <div className={styles.actions}>
            <Button
              variant="primary"
              onClick={handleRender}
              disabled={isRendering}
            >
              {isRendering
                ? 'Rendering…'
                : renderStatus === 'ready'
                  ? 'Re-render to MP4'
                  : 'Render to MP4'}
            </Button>
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

          {renderStatus === 'rendering' && (
            <div className={`${styles.statusBanner} ${styles.statusInfo}`}>
              <Spinner size="sm" /> Rendering in progress — typically 2-5 min for a 60s 1080p video.
            </div>
          )}

          {renderStatus === 'failed' && summary.renderError && (
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

          {summary.videoUrl && renderStatus === 'ready' && (
            <video
              className={styles.videoPlayer}
              controls
              src={summary.videoUrl}
              preload="metadata"
            />
          )}
        </>
      )}
    </div>
  )
}
