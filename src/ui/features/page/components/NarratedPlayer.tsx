import { useState, useRef, useEffect, useCallback } from 'react'

interface NarratedPlayerProps {
  videoUrl: string | null
  audioUrl: string | null
}

/**
 * Synced video + narration player.
 * Plays the original screen recording with the ElevenLabs voice-over narration
 * layered on top, synchronized by timestamp.
 */
export function NarratedPlayer({ videoUrl, audioUrl }: NarratedPlayerProps): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const rafRef = useRef<number | null>(null)

  // Sync audio with video on play/pause/seek
  const syncAudio = useCallback(() => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || !audio) return

    // Keep audio in sync — allow 0.3s drift before re-syncing
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

  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds)) return '0:00'
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
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

  // No video and no audio — nothing to show
  if (!videoUrl) return <></>

  return (
    <div style={{ marginBottom: 'var(--space-md)' }}>
      {/* Collapsed bar */}
      {!expanded && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-md)',
            padding: 'var(--space-sm) var(--space-md)',
            background: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            cursor: 'pointer',
          }}
          onClick={() => setExpanded(true)}
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
              src={videoUrl}
              preload="metadata"
              onLoadedMetadata={() => {
                if (videoRef.current) setDuration(videoRef.current.duration)
              }}
              onEnded={() => {
                setPlaying(false)
                audioRef.current?.pause()
              }}
              style={{ width: '100%', display: 'block', maxHeight: '400px' }}
            />
            {/* Play overlay */}
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

          {/* Hidden audio (synced with video) */}
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

            {/* Progress bar */}
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
