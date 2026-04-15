import { useState, useRef, useEffect, useCallback } from 'react'
import { Spinner } from '../../../design-system/components/index.js'

export interface VoiceoverSegment {
  stepIndex: number
  startTime: number
  endTime: number
  text?: string
}

interface NarratedPlayerProps {
  videoUrl: string | null
  audioUrl: string | null
  onDurationChange?: (duration: number) => void
}

type PlayerState = 'loading' | 'ready' | 'error'

/**
 * Pure video+audio player. No voice controls, no generation, no collapse.
 * Just plays video with synced narration audio overlay.
 */
export function NarratedPlayer({ videoUrl, audioUrl, onDurationChange }: NarratedPlayerProps): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playerState, setPlayerState] = useState<PlayerState>('loading')
  const rafRef = useRef<number | null>(null)

  const hasNarration = Boolean(audioUrl)

  // Reload audio when URL changes
  useEffect(() => {
    if (audioRef.current && audioUrl) audioRef.current.load()
  }, [audioUrl])

  // Track playback via rAF
  const tick = useCallback(() => {
    const video = videoRef.current
    const audio = audioRef.current
    if (video) setCurrentTime(video.currentTime)
    if (video && audio && !video.paused) {
      if (Math.abs(video.currentTime - audio.currentTime) > 0.3) {
        audio.currentTime = video.currentTime
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  useEffect(() => {
    if (playing) rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [playing, tick])

  // Loading timeout
  useEffect(() => {
    if (playerState !== 'loading') return
    const timeout = setTimeout(() => {
      if (playerState === 'loading') setPlayerState('error')
    }, 15000)
    return () => clearTimeout(timeout)
  }, [playerState])

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

  const fmt = (s: number): string => {
    if (!isFinite(s) || s < 0) return '0:00'
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
  }

  const progress = (duration > 0 && isFinite(duration)) ? currentTime / duration : 0

  if (!videoUrl) return <></>

  return (
    <div>
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
              setDuration(d); setPlayerState('ready'); onDurationChange?.(d)
            } else {
              // .webm files often report Infinity duration — mark ready anyway
              setPlayerState('ready')
            }
          }}
          onTimeUpdate={() => {
            // For .webm with Infinity duration: update duration as video plays
            const video = videoRef.current
            if (video && video.currentTime > duration) setDuration(video.currentTime + 1)
          }}
          onError={() => setPlayerState('error')}
          onEnded={() => { setPlaying(false); audioRef.current?.pause() }}
          style={{ width: '100%', display: 'block', maxHeight: '480px' }}
        />
        {playerState === 'loading' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}>
            <Spinner size="lg" />
          </div>
        )}
        {playerState === 'ready' && !playing && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.25)' }}>
            <svg width="56" height="56" viewBox="0 0 24 24" fill="rgba(255,255,255,0.9)" stroke="none"><polygon points="6 3 20 12 6 21 6 3" /></svg>
          </div>
        )}
        {playerState === 'error' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.7)' }}>
            <span style={{ color: 'var(--color-destructive)', fontSize: 'var(--text-sm)' }}>Failed to load video</span>
          </div>
        )}
      </div>

      {/* Audio (hidden) */}
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" />}

      {/* Controls */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
        padding: '10px var(--space-md)',
        background: 'var(--color-card)',
      }}>
        <button type="button" onClick={togglePlay} disabled={playerState !== 'ready'} style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          color: 'var(--color-fg)', display: 'flex', opacity: playerState === 'ready' ? 1 : 0.3,
        }}>
          {playing
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3" /></svg>
          }
        </button>

        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)', minWidth: 32 }}>
          {fmt(currentTime)}
        </span>

        <div onClick={handleSeek} style={{ flex: 1, height: 4, background: 'var(--color-secondary)', borderRadius: 2, cursor: 'pointer' }}>
          <div style={{ height: '100%', width: `${progress * 100}%`, background: 'var(--color-fg)', borderRadius: 2, transition: 'width 0.1s linear' }} />
        </div>

        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)', minWidth: 32, textAlign: 'right' }}>
          {fmt(duration)}
        </span>

        {hasNarration && (
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-success)', padding: '2px 6px', background: 'rgba(16,185,129,0.08)', borderRadius: 'var(--radius-full)' }}>
            narrated
          </span>
        )}

        {audioUrl && (
          <a href={audioUrl} download="narration.mp3" title="Download narration" style={{ display: 'flex', color: 'var(--color-muted-fg)', padding: 2 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" />
            </svg>
          </a>
        )}
      </div>
    </div>
  )
}
