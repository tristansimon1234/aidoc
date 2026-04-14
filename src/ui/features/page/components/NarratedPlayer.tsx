import { useState, useRef, useEffect, useCallback } from 'react'
import { Button, Spinner } from '../../../design-system/components/index.js'
import { VideoTimeline } from './VideoTimeline.js'

export interface VoiceoverSegment {
  stepIndex: number
  startTime: number
  endTime: number
  text?: string
}

interface NarratedPlayerProps {
  videoUrl: string | null
  audioUrl: string | null
  segments?: VoiceoverSegment[]
  runId?: string | null
  onGenerateVoiceover?: () => Promise<void>
  onSegmentsChange?: (segments: VoiceoverSegment[]) => void
}

export function NarratedPlayer({ videoUrl, audioUrl, segments, runId, onGenerateVoiceover, onSegmentsChange }: NarratedPlayerProps): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  const rafRef = useRef<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const hasNarration = Boolean(audioUrl || (segments && segments.length > 0))
  const hasSegments = segments && segments.length > 0

  // The rAF playback loop — updates progress bar
  const tick = useCallback(() => {
    const video = videoRef.current
    if (video && video.duration) {
      setProgress(video.currentTime / video.duration)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  useEffect(() => {
    if (playing) {
      rafRef.current = requestAnimationFrame(tick)
    } else {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [playing, tick])

  const syncAudio = (): void => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || !audio) return
    // Keep audio in sync — re-sync if drift exceeds 0.3s
    if (Math.abs(video.currentTime - audio.currentTime) > 0.3) {
      audio.currentTime = video.currentTime
    }
  }

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
      audio?.pause()
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

  const collapse = (): void => {
    setExpanded(false)
    setPlaying(false)
    videoRef.current?.pause()
    audioRef.current?.pause()
  }

  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds)) return '0:00'
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  // No video and no audio — show generate button only
  if (!videoUrl && !audioUrl && !hasSegments) {
    if (!onGenerateVoiceover) return <></>
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-md)',
        padding: 'var(--space-sm) var(--space-md)',
        background: 'var(--color-card)', border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)', marginBottom: 'var(--space-md)',
      }}>
        {generating ? (
          <>
            <Spinner size="sm" />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)' }}>Generating AI narration...</span>
          </>
        ) : (
          <Button size="sm" onClick={() => void handleGenerateVoiceover()}>
            Generate AI voice-over
          </Button>
        )}
      </div>
    )
  }

  // No video — just audio
  if (!videoUrl && audioUrl) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-md)',
        padding: 'var(--space-sm) var(--space-md)',
        background: 'var(--color-card)', border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)', marginBottom: 'var(--space-md)',
      }}>
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
          background: 'var(--color-card)', border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
        }}>
          <button type="button" onClick={() => setExpanded(true)} style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
            background: 'none', border: 'none', cursor: 'pointer', padding: 0, flex: 1,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-primary)' }}>
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
          {onGenerateVoiceover && !generating && (
            <Button size="sm" variant="secondary" onClick={() => void handleGenerateVoiceover()}>
              {hasNarration ? 'Regenerate voice' : 'Improve with AI'}
            </Button>
          )}
          {generating && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>
              <Spinner size="sm" /> Generating...
            </span>
          )}
        </div>
      )}

      {/* Expanded player */}
      {expanded && (
        <div style={{
          background: 'var(--color-card)', border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-xl)', overflow: 'hidden',
        }}>
          <div style={{ position: 'relative', background: '#000', cursor: 'pointer' }} onClick={togglePlay}>
            <video
              ref={videoRef}
              src={videoUrl!}
              preload="metadata"
              muted={hasNarration}
              onLoadedMetadata={() => { if (videoRef.current) setDuration(videoRef.current.duration) }}
              onEnded={() => { setPlaying(false); audioRef.current?.pause() }}
              style={{ width: '100%', display: 'block', maxHeight: '400px' }}
            />
            {!playing && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="6 3 20 12 6 21 6 3" /></svg>
              </div>
            )}
          </div>

          {/* Single audio track — synced with video via <break> tags */}
          {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" />}

          {/* Controls */}
          <div style={{ padding: 'var(--space-sm) var(--space-md)', display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <button type="button" onClick={togglePlay} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--color-fg)', display: 'flex' }}>
              {playing
                ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3" /></svg>
              }
            </button>
            <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)', minWidth: 36 }}>
              {formatTime(videoRef.current?.currentTime ?? 0)}
            </span>
            <div onClick={handleSeek} style={{ flex: 1, height: 6, background: 'var(--color-secondary)', borderRadius: 3, cursor: 'pointer' }}>
              <div style={{ height: '100%', width: `${progress * 100}%`, background: 'var(--color-primary)', borderRadius: 3 }} />
            </div>
            <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)', minWidth: 36, textAlign: 'right' }}>
              {formatTime(duration)}
            </span>
            {hasNarration && <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-success)' }}>{hasSegments ? 'synced' : 'narrated'}</span>}
            {onGenerateVoiceover && !generating && (
              <Button size="sm" variant="secondary" onClick={() => void handleGenerateVoiceover()}>
                {hasNarration ? 'Regenerate' : 'Improve with AI'}
              </Button>
            )}
            {generating && <Spinner size="sm" />}

            {/* Timeline toggle — only when segments exist and video is loaded */}
            {hasSegments && runId && duration > 0 && (
              <button
                type="button"
                onClick={() => setShowTimeline(!showTimeline)}
                title="Edit timeline"
                style={{
                  background: showTimeline ? 'var(--color-secondary)' : 'none',
                  border: 'none', cursor: 'pointer', padding: '2px 6px',
                  color: showTimeline ? 'var(--color-primary)' : 'var(--color-muted-fg)',
                  display: 'flex', alignItems: 'center', borderRadius: 'var(--radius-sm)',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" />
                </svg>
              </button>
            )}

            <button type="button" onClick={collapse} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--color-muted-fg)', display: 'flex' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6" /></svg>
            </button>
          </div>

          {/* Timeline editor */}
          {showTimeline && hasSegments && runId && (
            <VideoTimeline
              runId={runId}
              duration={duration}
              segments={segments!}
              onSegmentsChange={(updated) => {
                onSegmentsChange?.(updated)
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}
