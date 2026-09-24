import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, videoDuration, type Me, type Sop, type Voice } from '../api'
import { Button, Card, EmptyState, Field, StatusIndicator } from '../ui/design-system/components'
import type { StatusKey } from '../ui/design-system/tokens'
import { ScreenRecorder } from '../ui/ScreenRecorder'
import styles from './pages.module.css'

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
}

export function Home({ me, onChange }: { me: Me | null; onChange: () => void }) {
  const navigate = useNavigate()
  const [sops, setSops] = useState<Sop[] | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [duration, setDuration] = useState(0)
  const [title, setTitle] = useState('')
  const [language, setLanguage] = useState('en')
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
        setError(`Video too long (${me.maxVideoMinutes} min max).`)
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
          <h1 className={styles.title}>New procedure</h1>
          <p className={styles.subtitle}>
            Do the task while recording your screen: Doclee writes the procedure and edits a
            narrated video of 4 min max.
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
                Change
              </Button>
            </div>

            <Field
              label="Title"
              value={title}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
              required
              maxLength={200}
            />

            <div className={styles.row}>
              <label className={styles.select}>
                Procedure language
                <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {(me?.languages ?? ['en']).map((l) => (
                    <option key={l} value={l}>
                      {LANGUAGE_LABELS[l] ?? l}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.select}>
                Voice-over
                <select value={voice} onChange={(e) => setVoice(e.target.value as Voice)}>
                  <option value="standard">Yes</option>
                  {me?.premiumVoice && <option value="premium">Yes, premium voice</option>}
                  <option value="none">No, video only</option>
                </select>
              </label>
            </div>

            <div className={styles.actions}>
              {uploading !== null ? (
                <span className={styles.notice}>Uploading video… {uploading}%</span>
              ) : notEnough ? (
                <span className={styles.notice}>
                  You need {cost} credit{cost > 1 ? 's' : ''}.{' '}
                  <Link to="/credits">Buy credits</Link>
                </span>
              ) : (
                <Button type="submit">
                  Generate · {cost} credit{cost > 1 ? 's' : ''}
                </Button>
              )}
            </div>
          </form>
        </Card>
      )}
      {error && <p className={styles.error}>{error}</p>}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>My procedures</h2>
        {sops === null ? null : sops.length === 0 ? (
          <Card>
            <EmptyState
              title="No procedures yet"
              description="Record your screen or drop a video above to create your first one."
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
                    {new Date(s.createdAt).toLocaleDateString('en-GB')}
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
  if (s.status === 'ready') return 'Ready'
  if (s.status === 'processing') return s.progress ?? 'In progress'
  if (s.status === 'failed') return 'Failed'
  return 'Upload interrupted'
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
