import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, videoDuration, type Me, type Sop, type Voice } from '../api'
import { ScreenRecorder } from '../ScreenRecorder'

const LANGUAGE_LABELS: Record<string, string> = {
  fr: 'Français',
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
  nl: 'Nederlands',
}

export function Home({ me, onChange }: { me: Me | null; onChange: () => void }) {
  const navigate = useNavigate()
  const [sops, setSops] = useState<Sop[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [duration, setDuration] = useState(0)
  const [title, setTitle] = useState('')
  const [language, setLanguage] = useState('fr')
  const [voice, setVoice] = useState<Voice>('standard')
  const [uploading, setUploading] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    api
      .listSops()
      .then(setSops)
      .catch(() => {})
  useEffect(() => {
    void load()
  }, [])
  // Rafraîchit la liste tant qu'une SOP est en cours de génération.
  useEffect(() => {
    if (!sops.some((s) => s.status === 'processing')) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [sops])

  async function pick(f: File) {
    setError(null)
    try {
      const seconds = await videoDuration(f)
      if (me && seconds > me.maxVideoMinutes * 60) {
        setError(`Vidéo trop longue (maximum ${me.maxVideoMinutes} min).`)
        return
      }
      setFile(f)
      setDuration(seconds)
      if (!title) setTitle(f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setError(null)
    setUploading(0)
    try {
      const id = await api.createSop(
        { title, language, voice, file, durationSeconds: duration },
        setUploading,
      )
      onChange()
      navigate(`/sop/${id}`)
    } catch (err) {
      setError((err as Error).message)
      setUploading(null)
    }
  }

  const cost = me ? Math.max(1, Math.ceil(duration / (me.minutesPerCredit * 60))) : 1
  const notEnough = me !== null && me.credits < cost

  return (
    <>
      <section className="card">
        <h2>Nouvelle procédure</h2>

        {!file ? (
          <div className="stack">
            <label className="drop">
              <input
                type="file"
                accept="video/*"
                hidden
                onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])}
              />
              <strong>Choisir une vidéo</strong>
              <span className="muted">MP4, MOV, WebM · {me?.maxVideoMinutes ?? 60} min max</span>
            </label>
            <p className="muted center">ou</p>
            <ScreenRecorder onDone={pick} />
          </div>
        ) : (
          <form onSubmit={submit} className="stack">
            <p>
              🎬 {file.name} · {formatDuration(duration)}{' '}
              <button type="button" className="link" onClick={() => setFile(null)}>
                changer
              </button>
            </p>

            <label>
              Titre
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={200}
              />
            </label>

            <label>
              Langue de la procédure
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {(me?.languages ?? ['fr']).map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGE_LABELS[l] ?? l}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Voix off
              <select value={voice} onChange={(e) => setVoice(e.target.value as Voice)}>
                <option value="standard">Oui</option>
                {me?.premiumVoice && <option value="premium">Oui, voix premium</option>}
                <option value="none">Non, juste la vidéo</option>
              </select>
            </label>

            {uploading !== null ? (
              <p className="notice">Envoi de la vidéo… {uploading} %</p>
            ) : notEnough ? (
              <p className="notice">
                Cette vidéo demande {cost} crédit{cost > 1 ? 's' : ''}.{' '}
                <Link to="/credits">Acheter des crédits</Link>
              </p>
            ) : (
              <button className="primary">
                Générer · {cost} crédit{cost > 1 ? 's' : ''}
              </button>
            )}
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      {sops.length > 0 && (
        <section>
          <h2>Mes procédures</h2>
          <ul className="list">
            {sops.map((s) => (
              <li key={s.id}>
                <Link to={`/sop/${s.id}`}>{s.title}</Link>
                <span className={`status ${s.status}`}>{statusLabel(s)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

export function statusLabel(s: Sop): string {
  if (s.status === 'ready') return new Date(s.createdAt).toLocaleDateString('fr-FR')
  if (s.status === 'failed') return 'Échec'
  if (s.status === 'uploading') return 'Envoi interrompu'
  return s.progress ?? 'En cours'
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m} min ${s.toString().padStart(2, '0')}`
}
