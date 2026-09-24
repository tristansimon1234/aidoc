import { useEffect, useRef, useState } from 'react'
import { Button } from './design-system/components'
import styles from './ScreenRecorder.module.css'

/**
 * Deux grandes zones, comme sur l'ancienne plateforme : « Record my screen » et « Upload a video ».
 * L'enregistrement capture l'écran + le micro (si activé) directement dans le navigateur.
 */
export function ScreenRecorder({
  onFile,
  maxMinutes,
}: {
  onFile: (file: File) => void
  maxMinutes: number
}) {
  const [recording, setRecording] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)

  useEffect(() => {
    if (!recording) return
    const start = Date.now()
    const t = setInterval(() => {
      const seconds = Math.floor((Date.now() - start) / 1000)
      setElapsed(seconds)
      if (seconds >= maxMinutes * 60) recorder.current?.stop()
    }, 500)
    return () => clearInterval(t)
  }, [recording, maxMinutes])

  async function start() {
    setError(null)
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 },
        audio: false,
      })
      const mic = micEnabled
        ? await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
        : null
      const stream = new MediaStream([...screen.getVideoTracks(), ...(mic?.getAudioTracks() ?? [])])
      const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      )
      // 1,2 Mbit/s : le texte reste lisible et l'envoi reste léger.
      const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_200_000 })
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      rec.onstop = () => {
        screen.getTracks().forEach((t) => t.stop())
        mic?.getTracks().forEach((t) => t.stop())
        setRecording(false)
        setElapsed(0)
        const ext = rec.mimeType.includes('mp4') ? 'mp4' : 'webm'
        const name = `recording-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`
        onFile(new File(chunks, name, { type: rec.mimeType }))
      }
      // Le bouton « Arrêter le partage » du navigateur arrête aussi l'enregistrement.
      screen
        .getVideoTracks()[0]
        ?.addEventListener('ended', () => rec.state === 'recording' && rec.stop())
      rec.start(1000)
      recorder.current = rec
      setRecording(true)
    } catch {
      setError('Recording was cancelled or blocked by the browser.')
    }
  }

  const fmt = (s: number) =>
    `${Math.floor(s / 60)
      .toString()
      .padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`

  if (recording) {
    return (
      <div className={styles.recording}>
        <div className={styles.recordingLeft}>
          <span className={styles.recDot} />
          <span className={styles.recLabel}>Recording…</span>
          <span className={styles.timer}>
            {fmt(elapsed)} / {fmt(maxMinutes * 60)}
          </span>
        </div>
        <Button variant="secondary" onClick={() => recorder.current?.stop()}>
          Stop
        </Button>
      </div>
    )
  }

  return (
    <div className={styles.methods}>
      <button type="button" className={`${styles.zone} ${styles.recordZone}`} onClick={start}>
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="var(--color-destructive)"
          stroke="none"
        >
          <circle cx="12" cy="12" r="8" />
        </svg>
        <span className={styles.zoneTitle}>Record my screen</span>
        <span
          role="switch"
          aria-checked={micEnabled}
          tabIndex={0}
          className={`${styles.mic} ${micEnabled ? styles.micOn : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            setMicEnabled(!micEnabled)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              setMicEnabled(!micEnabled)
            }
          }}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          </svg>
          {micEnabled ? 'Mic on' : 'Mic off'}
        </span>
      </button>

      <label className={styles.zone}>
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={styles.uploadIcon}
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="m17 8-5-5-5 5" />
          <path d="M12 3v12" />
        </svg>
        <span className={styles.zoneTitle}>Upload a video</span>
        <span className={styles.zoneHint}>MP4, MOV, WebM… · {maxMinutes} min max</span>
        <input
          type="file"
          accept="video/*,.mp4,.webm,.mov,.mkv,.m4v"
          hidden
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
      </label>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  )
}
