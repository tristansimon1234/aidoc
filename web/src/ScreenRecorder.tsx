import { useRef, useState } from 'react'

/** Enregistre l'écran (+ le micro si autorisé) directement dans le navigateur. */
export function ScreenRecorder({ onDone }: { onDone: (file: File) => void }) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)

  async function start() {
    setError(null)
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 },
        audio: false,
      })
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
      const stream = new MediaStream([...screen.getVideoTracks(), ...(mic?.getAudioTracks() ?? [])])
      const chunks: Blob[] = []
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' })
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        screen.getTracks().forEach((t) => t.stop())
        setRecording(false)
        const name = `enregistrement-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.webm`
        onDone(new File(chunks, name, { type: 'video/webm' }))
      }
      // L'utilisateur peut aussi arrêter via le bouton « Arrêter le partage » du navigateur.
      screen
        .getVideoTracks()[0]
        ?.addEventListener('ended', () => rec.state === 'recording' && rec.stop())
      rec.start(1000)
      recorder.current = rec
      setRecording(true)
    } catch {
      setError("L'enregistrement a été annulé ou n'est pas autorisé.")
    }
  }

  return (
    <div className="stack center">
      {recording ? (
        <button className="danger" onClick={() => recorder.current?.stop()}>
          ■ Arrêter l'enregistrement
        </button>
      ) : (
        <button onClick={start}>● Enregistrer mon écran</button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
