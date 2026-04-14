import { useState, useRef, useEffect, useCallback } from 'react'
import { Button, Spinner } from '../../../design-system/components/index.js'
import { VideoTimeline } from './VideoTimeline.js'

export interface VoiceoverSegment {
  stepIndex: number
  startTime: number
  endTime: number
  text?: string
}

interface VoiceOption {
  voiceId: string
  name: string
}

interface NarratedPlayerProps {
  videoUrl: string | null
  audioUrl: string | null
  segments?: VoiceoverSegment[]
  runId?: string | null
  voices?: VoiceOption[]
  selectedVoiceId?: string
  onVoiceChange?: (voiceId: string) => void
  onGenerateVoiceover?: () => Promise<void>
  onSegmentsChange?: (segments: VoiceoverSegment[]) => void
  onVideoUrlChange?: (url: string) => void
}

type PlayerState = 'loading' | 'ready' | 'error'

export function NarratedPlayer({ videoUrl, audioUrl, segments, runId, voices, selectedVoiceId, onVoiceChange, onGenerateVoiceover, onSegmentsChange, onVideoUrlChange }: NarratedPlayerProps): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [playerState, setPlayerState] = useState<PlayerState>('loading')
  const rafRef = useRef<number | null>(null)

  const hasNarration = Boolean(audioUrl)
  const hasSegments = segments && segments.length > 0

  // Reload audio element when URL changes (e.g., after regeneration)
  useEffect(() => {
    if (audioRef.current && audioUrl) {
      audioRef.current.load()
    }
  }, [audioUrl])

  // Track playback position via requestAnimationFrame
  const tick = useCallback(() => {
    const video = videoRef.current
    if (video) {
      setCurrentTime(video.currentTime)
    }
    // Sync audio with video (re-sync if drift > 0.3s)
    const audio = audioRef.current
    if (video && audio && !video.paused) {
      if (Math.abs(video.currentTime - audio.currentTime) > 0.3) {
        audio.currentTime = video.currentTime
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  useEffect(() => {
    if (playing) {
      rafRef.current = requestAnimationFrame(tick)
    }
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [playing, tick])

  // Timeout: if video doesn't load within 10s, show error
  useEffect(() => {
    if (playerState !== 'loading' || !expanded) return
    const timeout = setTimeout(() => {
      if (playerState === 'loading') setPlayerState('error')
    }, 10000)
    return () => clearTimeout(timeout)
  }, [playerState, expanded])

  const togglePlay = (): void => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || playerState !== 'ready') return

    if (video.paused) {
      if (audio) audio.currentTime = video.currentTime
      void video.play()
      if (audio) void audio.play()
      setPlaying(true)
    } else {
      video.pause()
      audio?.pause()
      setPlaying(false)
    }
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>): void => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const t = pct * duration
    video.currentTime = t
    if (audio) audio.currentTime = t
    setCurrentTime(t)
  }

  const handleGenerateVoiceover = async (): Promise<void> => {
    if (!onGenerateVoiceover) return
    setGenerating(true)
    setGenError(null)
    try {
      await onGenerateVoiceover()
    } catch (err) {
      setGenError((err as Error).message ?? 'Voice-over generation failed')
    } finally {
      setGenerating(false)
    }
  }

  const collapse = (): void => {
    setExpanded(false)
    setPlaying(false)
    videoRef.current?.pause()
    audioRef.current?.pause()
  }

  const fmt = (s: number): string => {
    if (!isFinite(s) || s < 0) return '0:00'
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
  }

  const progress = duration > 0 ? currentTime / duration : 0

  // === No video at all — just show generate button ===
  if (!videoUrl) {
    if (!onGenerateVoiceover) return <></>
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-md)',
        padding: 'var(--space-sm) var(--space-md)',
        background: 'var(--color-card)', border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)', marginBottom: 'var(--space-md)',
      }}>
        {generating ? (
          <><Spinner size="sm" /><span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)' }}>Generating voice-over...</span></>
        ) : (
          <Button size="sm" onClick={() => void handleGenerateVoiceover()}>Generate AI voice-over</Button>
        )}
        {genError && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-destructive)' }}>{genError}</span>}
      </div>
    )
  }

  // === Has video ===
  return (
    <div style={{ marginBottom: 'var(--space-md)' }}>
      {/* Collapsed bar */}
      {!expanded && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
          padding: 'var(--space-sm) var(--space-md)',
          background: 'var(--color-card)', border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
        }}>
          <button type="button" onClick={() => setExpanded(true)} style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
            background: 'none', border: 'none', cursor: 'pointer', padding: 0, flex: 1,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--color-primary)' }}>
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg)', fontWeight: 500 }}>
              {hasNarration ? 'Watch narrated video' : 'Watch recording'}
            </span>
            {hasNarration && (
              <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-success)', padding: '1px 6px', background: 'rgba(0,200,0,0.1)', borderRadius: 'var(--radius-sm)' }}>
                AI narration
              </span>
            )}
          </button>
          {voices && voices.length > 0 && onVoiceChange && (
            <select
              value={selectedVoiceId ?? ''}
              onChange={(e) => onVoiceChange(e.target.value)}
              style={{
                fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
                background: 'var(--color-secondary)', color: 'var(--color-fg)',
                border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
                padding: '2px 6px', cursor: 'pointer',
              }}
            >
              {voices.map((v) => (
                <option key={v.voiceId} value={v.voiceId}>{v.name}</option>
              ))}
            </select>
          )}
          {onGenerateVoiceover && !generating && (
            <Button size="sm" variant="secondary" onClick={() => void handleGenerateVoiceover()}>
              {hasNarration ? 'Regenerate voice' : 'Improve with AI'}
            </Button>
          )}
          {generating && <><Spinner size="sm" /><span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>Generating...</span></>}
          {genError && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-destructive)' }}>{genError}</span>}
        </div>
      )}

      {/* Expanded player */}
      {expanded && (
        <div style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-xl)', overflow: 'hidden' }}>
          {/* Video */}
          <div style={{ position: 'relative', background: '#000', cursor: 'pointer' }} onClick={togglePlay}>
            <video
              ref={videoRef}
              src={videoUrl}
              preload="metadata"
              muted={hasNarration}
              onLoadedMetadata={() => {
                const d = videoRef.current?.duration ?? 0
                if (d > 0 && isFinite(d)) {
                  setDuration(d)
                  setPlayerState('ready')
                }
              }}
              onError={() => setPlayerState('error')}
              onEnded={() => { setPlaying(false); audioRef.current?.pause() }}
              style={{ width: '100%', display: 'block', maxHeight: '400px' }}
            />
            {playerState === 'loading' && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}>
                <Spinner size="lg" />
              </div>
            )}
            {playerState === 'ready' && !playing && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="6 3 20 12 6 21 6 3" /></svg>
              </div>
            )}
            {playerState === 'error' && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.7)' }}>
                <span style={{ color: 'var(--color-destructive)', fontSize: 'var(--text-sm)' }}>Failed to load video</span>
              </div>
            )}
          </div>

          {/* Hidden audio element for narration */}
          {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" />}

          {/* Controls bar */}
          <div style={{ padding: 'var(--space-sm) var(--space-md)', display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            {/* Play/Pause */}
            <button type="button" onClick={togglePlay} disabled={playerState !== 'ready'} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--color-fg)', display: 'flex', opacity: playerState === 'ready' ? 1 : 0.3 }}>
              {playing
                ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3" /></svg>
              }
            </button>

            {/* Current time */}
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)', minWidth: 36 }}>
              {fmt(currentTime)}
            </span>

            {/* Progress bar */}
            <div onClick={handleSeek} style={{ flex: 1, height: 6, background: 'var(--color-secondary)', borderRadius: 3, cursor: 'pointer' }}>
              <div style={{ height: '100%', width: `${progress * 100}%`, background: 'var(--color-primary)', borderRadius: 3 }} />
            </div>

            {/* Duration */}
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)', minWidth: 36, textAlign: 'right' }}>
              {fmt(duration)}
            </span>

            {/* Narration badge */}
            {hasNarration && <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-success)' }}>narrated</span>}

            {/* Voice selector */}
            {voices && voices.length > 0 && onVoiceChange && (
              <select
                value={selectedVoiceId ?? ''}
                onChange={(e) => onVoiceChange(e.target.value)}
                style={{
                  fontSize: 11, fontFamily: 'var(--font-mono)',
                  background: 'var(--color-secondary)', color: 'var(--color-fg)',
                  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
                  padding: '2px 6px', cursor: 'pointer', maxWidth: 120,
                }}
              >
                {voices.map((v) => (
                  <option key={v.voiceId} value={v.voiceId}>{v.name}</option>
                ))}
              </select>
            )}

            {/* Regenerate */}
            {onGenerateVoiceover && !generating && (
              <Button size="sm" variant="secondary" onClick={() => void handleGenerateVoiceover()}>
                {hasNarration ? 'Regenerate' : 'Improve with AI'}
              </Button>
            )}
            {generating && <Spinner size="sm" />}

            {/* Download audio */}
            {audioUrl && (
              <a href={audioUrl} download="narration.mp3" title="Download narration" style={{ display: 'flex', color: 'var(--color-muted-fg)', padding: 2 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" />
                </svg>
              </a>
            )}

            {/* Timeline toggle */}
            {hasSegments && runId && duration > 0 && (
              <button type="button" onClick={() => setShowTimeline(!showTimeline)} title="Edit timeline"
                style={{ background: showTimeline ? 'var(--color-secondary)' : 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', color: showTimeline ? 'var(--color-primary)' : 'var(--color-muted-fg)', display: 'flex', borderRadius: 'var(--radius-sm)' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" /></svg>
              </button>
            )}

            {/* Collapse */}
            <button type="button" onClick={collapse} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--color-muted-fg)', display: 'flex' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m18 15-6-6-6 6" /></svg>
            </button>
          </div>

          {/* Generation error */}
          {genError && (
            <div style={{ padding: '0 var(--space-md) var(--space-sm)', fontSize: 'var(--text-xs)', color: 'var(--color-destructive)' }}>
              {genError}
            </div>
          )}

          {/* Timeline editor */}
          {showTimeline && hasSegments && runId && duration > 0 && (
            <VideoTimeline
              runId={runId}
              duration={duration}
              segments={segments!}
              onSegmentsChange={(s) => onSegmentsChange?.(s)}
              onVideoTrimmed={(url) => onVideoUrlChange?.(url)}
            />
          )}
        </div>
      )}
    </div>
  )
}
