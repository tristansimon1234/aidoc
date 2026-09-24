import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, videoDuration, type Me, type Sop, type Voice } from '../api'
import { Button, Card, EmptyState, Field, StatusIndicator } from '../ui/design-system/components'
import type { StatusKey } from '../ui/design-system/tokens'
import { ScreenRecorder } from '../ui/ScreenRecorder'
import styles from './pages.module.css'

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
  const [sops, setSops] = useState<Sop[] | null>(null)
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
      .catch(() => setSops([]))
  useEffect(() => {
    void load()
  }, [])
  // Rafraîchit la liste tant qu'une procédure est en cours de génération.
  useEffect(() => {
    if (!sops?.some((s) => s.status === 'processing')) return
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
      setTitle(f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '))
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
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Nouvelle procédure</h1>
          <p className={styles.subtitle}>
            Réalisez la tâche en filmant votre écran : Doclee rédige la procédure et monte une vidéo
            commentée de 4 min max.
          </p>
        </div>
      </div>

      {!file ? (
        <ScreenRecorder onFile={pick} maxMinutes={me?.maxVideoMinutes ?? 60} />
      ) : (
        <Card>
          <form className={styles.form} onSubmit={(e) => void submit(e)}>
            <div className={styles.fileRow}>
              <span className={styles.fileName}>{file.name}</span>
              <span className={styles.mono}>{formatDuration(duration)}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setFile(null)}>
                Changer
              </Button>
            </div>

            <Field
              label="Titre"
              value={title}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
              required
              maxLength={200}
            />

            <div className={styles.row}>
              <label className={styles.select}>
                Langue de la procédure
                <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {(me?.languages ?? ['fr']).map((l) => (
                    <option key={l} value={l}>
                      {LANGUAGE_LABELS[l] ?? l}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.select}>
                Voix off
                <select value={voice} onChange={(e) => setVoice(e.target.value as Voice)}>
                  <option value="standard">Oui</option>
                  {me?.premiumVoice && <option value="premium">Oui, voix premium</option>}
                  <option value="none">Non, vidéo seule</option>
                </select>
              </label>
            </div>

            <div className={styles.actions}>
              {uploading !== null ? (
                <span className={styles.notice}>Envoi de la vidéo… {uploading} %</span>
              ) : notEnough ? (
                <span className={styles.notice}>
                  Il faut {cost} crédit{cost > 1 ? 's' : ''}.{' '}
                  <Link to="/credits">Acheter des crédits</Link>
                </span>
              ) : (
                <Button type="submit">
                  Générer · {cost} crédit{cost > 1 ? 's' : ''}
                </Button>
              )}
            </div>
          </form>
        </Card>
      )}
      {error && <p className={styles.error}>{error}</p>}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Mes procédures</h2>
        {sops === null ? null : sops.length === 0 ? (
          <Card>
            <EmptyState
              title="Aucune procédure pour l’instant"
              description="Enregistrez votre écran ou déposez une vidéo ci-dessus pour créer la première."
            />
          </Card>
        ) : (
          <div className={styles.grid}>
            {sops.map((s) => (
              <Card key={s.id} onClick={() => navigate(`/sop/${s.id}`)}>
                <p className={styles.cardTitle}>{s.title}</p>
                <div className={styles.cardMeta}>
                  <StatusIndicator status={statusKey(s)} label={statusLabel(s)} />
                  <span className={styles.mono}>
                    {new Date(s.createdAt).toLocaleDateString('fr-FR')}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function statusKey(s: Sop): StatusKey {
  if (s.status === 'ready') return 'completed'
  if (s.status === 'processing') return 'running'
  if (s.status === 'failed') return 'failed'
  return 'blocked'
}

function statusLabel(s: Sop): string {
  if (s.status === 'ready') return 'Prête'
  if (s.status === 'processing') return s.progress ?? 'En cours'
  if (s.status === 'failed') return 'Échec'
  return 'Envoi interrompu'
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
