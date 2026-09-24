import { useState, type ChangeEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, videoDuration, type Kind, type Me } from '../api'
import { Button, Card, Field } from '../ui/design-system/components'
import { ScreenRecorder } from '../ui/ScreenRecorder'
import { VoicePicker, loadVoiceChoice } from '../ui/VoicePicker'
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

const STEPS = ['Type', 'Video', 'Options', 'Generate']

const KINDS: { id: Kind; title: string; text: string }[] = [
  {
    id: 'sop',
    title: 'SOP',
    text: 'A step-by-step procedure with screenshots, plus a narrated video of 4 min max.',
  },
  {
    id: 'marketing',
    title: 'Marketing video',
    text: 'A punchy 30 or 60-second video that shows off your product, with voice-over and music.',
  },
]

/** Création en 4 étapes : type → vidéo → options → lancement. */
export function Create({ me, onChange }: { me: Me | null; onChange: () => void }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const initialKind = params.get('kind')
  const [step, setStep] = useState(initialKind === 'sop' || initialKind === 'marketing' ? 1 : 0)
  const [kind, setKind] = useState<Kind>(initialKind === 'marketing' ? 'marketing' : 'sop')

  const [file, setFile] = useState<File | null>(null)
  const [duration, setDuration] = useState(0)
  const [title, setTitle] = useState('')
  const [language, setLanguage] = useState('en')
  const [{ voice, tone }, setVoiceChoice] = useState(loadVoiceChoice)
  const [brief, setBrief] = useState('')
  const [targetSeconds, setTargetSeconds] = useState<30 | 60>(60)
  const [music, setMusic] = useState(true)

  const [uploading, setUploading] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

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
      setStep(2)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function generate() {
    if (!file) return
    setError(null)
    setUploading(0)
    try {
      const id = await api.createSop(
        {
          kind,
          title,
          language,
          // Une vidéo marketing a toujours une voix off.
          voice: kind === 'marketing' && voice === 'none' ? 'gemini:Puck' : voice,
          tone,
          brief,
          targetSeconds,
          music: kind === 'marketing' && music,
          file,
          durationSeconds: duration,
        },
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
  const kindLabel = KINDS.find((k) => k.id === kind)!.title

  return (
    <>
      <Stepper current={step} onGo={(i) => i < step && setStep(i)} />

      {step === 0 && (
        <Panel title="What do you want to create?" subtitle="Both start from a screen recording.">
          <div className={styles.choices}>
            {KINDS.map((k) => (
              <Card
                key={k.id}
                onClick={() => {
                  setKind(k.id)
                  setStep(file ? 2 : 1)
                }}
              >
                <p className={styles.choiceTitle}>{k.title}</p>
                <p className={styles.notice}>{k.text}</p>
              </Card>
            ))}
          </div>
        </Panel>
      )}

      {step === 1 && (
        <Panel
          title="Your video"
          subtitle={
            kind === 'sop'
              ? 'Do the task while recording your screen, and explain what you do out loud.'
              : 'Show your product in action. Talking about its benefits helps the script.'
          }
        >
          <ScreenRecorder onFile={pick} maxMinutes={me?.maxVideoMinutes ?? 60} />
        </Panel>
      )}

      {step === 2 && file && (
        <Panel title="Options" subtitle={`${kindLabel} · ${file.name}`}>
          <Card>
            <div className={styles.form}>
              <Field
                label="Title"
                value={title}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
                required
                maxLength={200}
              />
              <label className={styles.select}>
                Language
                <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {(me?.languages ?? ['en']).map((l) => (
                    <option key={l} value={l}>
                      {LANGUAGE_LABELS[l] ?? l}
                    </option>
                  ))}
                </select>
              </label>

              {kind === 'marketing' && (
                <>
                  <Field
                    label="Brief (optional): what to highlight, for whom, the message"
                    multiline
                    rows={3}
                    placeholder="e.g. For accounting firms: show how fast invoices are booked, end with “Book a demo”."
                    value={brief}
                    onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setBrief(e.target.value)}
                    maxLength={2000}
                  />
                  <label className={styles.select}>
                    Length
                    <select
                      value={targetSeconds}
                      onChange={(e) => setTargetSeconds(Number(e.target.value) === 30 ? 30 : 60)}
                    >
                      <option value={30}>30 seconds</option>
                      <option value={60}>60 seconds</option>
                    </select>
                  </label>
                </>
              )}

              <VoicePicker
                language={language}
                tones={me?.tones ?? []}
                voice={voice}
                tone={tone}
                onChange={setVoiceChoice}
              />

              {kind === 'marketing' && me?.musicAvailable && (
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={music}
                    onChange={(e) => setMusic(e.target.checked)}
                  />
                  Background music
                </label>
              )}

              <div className={styles.actions}>
                <Button type="button" onClick={() => setStep(3)} disabled={!title.trim()}>
                  Continue
                </Button>
              </div>
            </div>
          </Card>
        </Panel>
      )}

      {step === 3 && file && (
        <Panel title="Ready to generate" subtitle="It takes a few minutes. You can close the page.">
          <Card>
            <dl className={styles.summary}>
              <dt>Type</dt>
              <dd>{kindLabel}</dd>
              <dt>Title</dt>
              <dd>{title}</dd>
              <dt>Video</dt>
              <dd>
                {file.name} · {Math.floor(duration / 60)}:
                {String(Math.round(duration % 60)).padStart(2, '0')}
              </dd>
              <dt>Language</dt>
              <dd>{LANGUAGE_LABELS[language] ?? language}</dd>
              {kind === 'marketing' && (
                <>
                  <dt>Length</dt>
                  <dd>{targetSeconds} seconds</dd>
                </>
              )}
              <dt>Cost</dt>
              <dd>
                {cost} credit{cost > 1 ? 's' : ''}
              </dd>
            </dl>
            <div className={styles.actions}>
              {uploading !== null ? (
                <span className={styles.notice}>Uploading video… {uploading}%</span>
              ) : notEnough ? (
                <span className={styles.notice}>
                  You need {cost} credit{cost > 1 ? 's' : ''}.{' '}
                  <Link to="/credits">Buy credits</Link>
                </span>
              ) : (
                <Button type="button" onClick={() => void generate()}>
                  Generate
                </Button>
              )}
            </div>
          </Card>
        </Panel>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </>
  )
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

/** Étapes numérotées ; on peut revenir en arrière en cliquant sur une étape passée. */
function Stepper({ current, onGo }: { current: number; onGo: (step: number) => void }) {
  return (
    <ol className={styles.stepper}>
      {STEPS.map((label, i) => (
        <li
          key={label}
          className={i === current ? styles.stepActive : i < current ? styles.stepDone : ''}
        >
          <button type="button" onClick={() => onGo(i)} disabled={i >= current}>
            <span className={styles.stepNumber}>{i + 1}</span>
            {label}
          </button>
        </li>
      ))}
    </ol>
  )
}
