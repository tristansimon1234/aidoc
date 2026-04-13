import { useState, useRef, useEffect, useCallback } from 'react'
import { Button, Spinner } from '../../../design-system/components/index.js'

interface NarratedPlayerProps {
  videoUrl: string | null
  audioUrl: string | null
  onGenerateVoiceover?: () => Promise<void>
}

/**
 * Synced video + narration player.
 * Shows the recording with optional AI narration.
 * When no narration exists, shows an "Improve video with AI" button.
 */
export function NarratedPlayer({ videoUrl, audioUrl, onGenerateVoiceover }: NarratedPlayerProps): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [generating, setGenerating] = useState(false)
  const rafRef = useRef<number | null>(null)

  const syncAudio = useCallback(() => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || !audio) return
    if (Math.abs(video.currentTime - audio.currentTime) > 0.3) {
      audio.currentTime = video.currentTime
    }
  }, [])

  const updateProgress = useCallback(() => {
    const video = videoRef.current
    if (video && video.duration) {
      setProgress(video.currentTime / video.duration)
    }
    if (playing) {
      rafRef.current = requestAnimationFrame(updateProgress)
    }
  }, [playing])

  useEffect(() => {
    if (playing) {
      rafRef.current = requestAnimationFrame(updateProgress)
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [playing, updateProgress])

  const togglePlay = (): void => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video) return
    if (video.paused) {
      syncAudio()
      void video.play()
      if (audio) void audio.play()
      setPlaying(true)
    } else {
      video.pause()
      if (audio) audio.pause()
      setPlaying(false)
    }
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>): void => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || !video.duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    video.currentTime = pct * video.duration
    if (audio) audio.currentTime = pct * video.duration
    setProgress(pct)
  }

  const handleGenerateVoiceover = async (): Promise<void> => {
    if (!onGenerateVoiceover) return
    setGenerating(true)
    try {
      await onGenerateVoiceover()
    } finally {
      setGenerating(false)
    }
  }

  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds)) return '0:00'
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  // No video and no audio — show just the generate button if available
  if (!videoUrl && !audioUrl) {
    if (!onGenerateVoiceover) return <></>
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-md)',
        padding: 'var(--space-sm) var(--space-md)',
        background: 'var(--color-card)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        marginBottom: 'var(--space-md)',
      }}>
        {generating ? (
          <>
            <Spinner size="sm" />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)' }}>Generating AI narration...</span>
          </>
        ) : (
          <Button size="sm" onClick={() => void handleGenerateVoiceover()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
            </svg>
            Generate AI voice-over
          </Button>
        )}
      </div>
    )
  }

  // No video — just show audio player
  if (!videoUrl && audioUrl) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-md)',
        padding: 'var(--space-sm) var(--space-md)',
        background: 'var(--color-card)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        marginBottom: 'var(--space-md)',
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--color-primary)' }}>
          <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
        </svg>
        <audio controls preload="none" src={audioUrl} style={{ flex: 1, height: 32 }} />
      </div>
    )
  }

  // Has video — full player
  return (
    <div style={{ marginBottom: 'var(--space-md)' }}>
      {/* Collapsed bar */}
      {!expanded && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
          padding: 'var(--space-sm) var(--space-md)',
          background: 'var(--color-card)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
        }}>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0, flex: 1,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--color-primary)' }}>
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg)', fontWeight: 500 }}>
              {audioUrl ? 'Watch narrated video' : 'Watch recording'}
            </span>
            {audioUrl && (
              <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-success)', padding: '1px 6px', background: 'rgba(0,200,0,0.1)', borderRadius: 'var(--radius-sm)' }}>
                AI narration
              </span>
            )}
          </button>

          {/* Improve button — visible when video exists but no narration */}
          {!audioUrl && onGenerateVoiceover && !generating && (
            <Button size="sm" variant="secondary" onClick={() => void handleGenerateVoiceover()}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
              </svg>
              Improve with AI
            </Button>
          )}
          {generating && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>
              <Spinner size="sm" /> Generating narration...
            </span>
          )}
        </div>
      )}

      {/* Expanded player */}
      {expanded && (
        <div style={{
          background: 'var(--color-card)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-xl)',
          overflow: 'hidden',
        }}>
          {/* Video */}
          <div style={{ position: 'relative', background: '#000', cursor: 'pointer' }} onClick={togglePlay}>
            <video
              ref={videoRef}
              src={videoUrl!}
              preload="metadata"
              onLoadedMetadata={() => { if (videoRef.current) setDuration(videoRef.current.duration) }}
              onEnded={() => { setPlaying(false); audioRef.current?.pause() }}
              style={{ width: '100%', display: 'block', maxHeight: '400px' }}
            />
            {!playing && (
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.3)',
              }}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="white" stroke="none">
                  <polygon points="6 3 20 12 6 21 6 3" />
                </svg>
              </div>
            )}
          </div>

          {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" />}

          {/* Controls bar */}
          <div style={{ padding: 'var(--space-sm) var(--space-md)', display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <button type="button" onClick={togglePlay} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              color: 'var(--color-fg)', display: 'flex', alignItems: 'center',
            }}>
              {playing ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3" /></svg>
              )}
            </button>

            <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)', minWidth: '36px' }}>
              {formatTime(videoRef.current?.currentTime ?? 0)}
            </span>

            <div
              style={{
                flex: 1, height: 6, background: 'var(--color-secondary)',
                borderRadius: 3, cursor: 'pointer', position: 'relative',
              }}
              onClick={handleSeek}
            >
              <div style={{
                height: '100%', width: `${progress * 100}%`,
                background: 'var(--color-primary)', borderRadius: 3,
                transition: playing ? 'none' : 'width 0.1s',
              }} />
            </div>

            <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)', minWidth: '36px', textAlign: 'right' }}>
              {formatTime(duration)}
            </span>

            {audioUrl && (
              <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-success)' }}>
                narrated
              </span>
            )}

            {/* Improve button inside expanded player */}
            {!audioUrl && onGenerateVoiceover && !generating && (
              <Button size="sm" variant="secondary" onClick={() => void handleGenerateVoiceover()}>
                Improve with AI
              </Button>
            )}
            {generating && <Spinner size="sm" />}

            <button type="button" onClick={() => { setExpanded(false); setPlaying(false); videoRef.current?.pause(); audioRef.current?.pause() }} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              color: 'var(--color-muted-fg)', display: 'flex', alignItems: 'center',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m18 15-6-6-6 6" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
