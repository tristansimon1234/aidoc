import { useCallback, useEffect, useRef, useState } from 'react'
import { Spinner } from './design-system/components'
import styles from './NarratedPlayer.module.css'

type PlayerState = 'loading' | 'ready' | 'error'

/** Lecteur de l'ancienne plateforme : image noire, gros bouton lecture, barre de contrôle sobre en dessous. */
export function NarratedPlayer({ videoUrl, narrated }: { videoUrl: string; narrated: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [state, setState] = useState<PlayerState>('loading')
  const raf = useRef<number | null>(null)

  const tick = useCallback(() => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime)
    raf.current = requestAnimationFrame(tick)
  }, [])

  useEffect(() => {
    if (playing) raf.current = requestAnimationFrame(tick)
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [playing, tick])

  const toggle = () => {
    const video = videoRef.current
    if (!video || state !== 'ready') return
    if (video.paused) {
      void video.play()
      setPlaying(true)
    } else {
      video.pause()
      setPlaying(false)
    }
  }

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current
    if (!video || duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration
    video.currentTime = t
    setCurrentTime(t)
  }

  const fmt = (s: number) =>
    !isFinite(s) || s < 0
      ? '0:00'
      : `${Math.floor(s / 60)}:${Math.floor(s % 60)
          .toString()
          .padStart(2, '0')}`

  return (
    <div className={styles.player}>
      <div className={styles.screen} onClick={toggle}>
        <video
          ref={videoRef}
          src={videoUrl}
          preload="metadata"
          className={styles.video}
          onLoadedMetadata={() => {
            setDuration(videoRef.current?.duration ?? 0)
            setState('ready')
          }}
          onError={() => setState('error')}
          onEnded={() => setPlaying(false)}
        />
        {state === 'loading' && (
          <div className={styles.overlay}>
            <Spinner size="lg" />
          </div>
        )}
        {state === 'ready' && !playing && (
          <div className={`${styles.overlay} ${styles.paused}`}>
            <svg width="56" height="56" viewBox="0 0 24 24" fill="rgba(255,255,255,0.9)">
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
          </div>
        )}
        {state === 'error' && (
          <div className={`${styles.overlay} ${styles.failed}`}>Impossible de charger la vidéo</div>
        )}
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          onClick={toggle}
          disabled={state !== 'ready'}
          className={styles.play}
          aria-label={playing ? 'Pause' : 'Lecture'}
        >
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
          )}
        </button>
        <span className={styles.time}>{fmt(currentTime)}</span>
        <div className={styles.track} onClick={seek}>
          <div
            className={styles.progress}
            style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
          />
        </div>
        <span className={styles.time}>{fmt(duration)}</span>
        {narrated && <span className={styles.badge}>narrée</span>}
        <a href={videoUrl} download title="Télécharger la vidéo" className={styles.download}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" x2="12" y1="15" y2="3" />
          </svg>
        </a>
      </div>
    </div>
  )
}
