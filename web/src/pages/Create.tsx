import { useState, type ChangeEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, videoDuration, type Kind, type Me } from '../api'
import { Button, Card, Field } from '../ui/design-system/components'
import { ScreenRecorder } from '../ui/ScreenRecorder'
import { ScreenshotPicker } from '../ui/ScreenshotPicker'
import { VoicePicker, loadVoiceChoice } from '../ui/VoicePicker'
import { DocIcon, FilmIcon } from './Home'
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

const STEPS = (kind: Kind) => [
  'Type',
  kind === 'sop' ? 'Video' : 'Screenshots',
  'Options',
  'Generate',
]

const KINDS: { id: Kind; title: string; text: string }[] = [
  {
    id: 'sop',
    title: 'SOP',
    text: 'From a screen recording: a step-by-step procedure with screenshots, plus a narrated video of 4 min max.',
  },
  {
    id: 'marketing',
    title: 'Marketing video',
    text: 'From a few screenshots: a 30 or 60-second animated video that shows off your product, with voice-over, captions and music.',
  },
]

/** Création en 4 étapes : type → vidéo (SOP) ou captures (marketing) → options → lancement. */
export function Create({ me, onChange }: { me: Me | null; onChange: () => void }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const initialKind = params.get('kind')
  const [step, setStep] = useState(initialKind === 'sop' || initialKind === 'marketing' ? 1 : 0)
  const [kind, setKind] = useState<Kind>(initialKind === 'marketing' ? 'marketing' : 'sop')

  const [file, setFile] = useState<File | null>(null)
  const [screenshots, setScreenshots] = useState<File[]>([])
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

  // Ce qui a été fourni pour le type choisi : la vidéo (SOP) ou au moins une capture (marketing).
  const hasSource = kind === 'sop' ? file !== null : screenshots.length > 0

  async function generate() {
    if (!hasSource) return
    setError(null)
    setUploading(0)
    try {
      const id = await api.createSop(
        {
          kind,
          title,
          language,
          // Une vidéo marketing a toujours une voix off.
          voice: kind === 'marketing' && voice === 'none' ? '' : voice,
          tone,
          brief,
          targetSeconds,
          music: kind === 'marketing' && music,
          video: kind === 'sop' && file ? { file, durationSeconds: duration } : undefined,
          screenshots: kind === 'marketing' ? screenshots : undefined,
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

  const cost = !me
    ? 1
    : kind === 'marketing'
      ? me.marketingCredits
      : Math.max(1, Math.ceil(duration / (me.minutesPerCredit * 60)))
  const notEnough = me !== null && me.credits < cost
  const kindLabel = KINDS.find((k) => k.id === kind)!.title

  return (
    <>
      <Stepper labels={STEPS(kind)} current={step} onGo={(i) => i < step && setStep(i)} />

      {step === 0 && (
        <Panel
          title="What do you want to create?"
          subtitle="Pick one: the next steps adapt to it, and everything is generated for you in a few minutes."
        >
          <div className={styles.choices}>
            {KINDS.map((k) => (
              <Card
                key={k.id}
                className={styles.choice}
                onClick={() => {
                  setKind(k.id)
                  setStep((k.id === 'sop' ? file : screenshots.length > 0) ? 2 : 1)
                }}
              >
                <span className={styles.choiceIcon}>
                  {k.id === 'sop' ? <DocIcon /> : <FilmIcon />}
                </span>
                <p className={styles.choiceTitle}>{k.title}</p>
                <p className={styles.notice}>{k.text}</p>
              </Card>
            ))}
          </div>
        </Panel>
      )}

      {step === 1 && kind === 'sop' && (
        <Panel
          title="Your video"
          subtitle="Do the task once, from start to finish, while recording your screen."
          tips={[
            'Talk as you go: say why you click, the rules to follow and the pitfalls. The procedure and the voice-over are written from what you say.',
            'Go at your normal pace: hesitations and dead time are cut out.',
            `Up to ${me?.maxVideoMinutes ?? 60} min. The narrated video is edited down to 4 min max.`,
          ]}
        >
          <ScreenRecorder onFile={pick} maxMinutes={me?.maxVideoMinutes ?? 60} />
        </Panel>
      )}

      {step === 1 && kind === 'marketing' && (
        <Panel
          title="Your screenshots"
          subtitle="The screens that show your product at its best. They are not shown as is: the AI redraws them as clean, animated mockups."
          tips={[
            'Pick 3 to 8 key screens: the main page, the key feature, a result or a dashboard.',
            'Use clean screens without personal data. Their colors become the colors of the video.',
            'Fastest: take a screenshot, then paste it here with ⌘V / Ctrl+V.',
          ]}
        >
          <ScreenshotPicker
            files={screenshots}
            max={me?.maxScreenshots ?? 8}
            onChange={setScreenshots}
          />
          <div className={styles.actions}>
            <Button type="button" onClick={() => setStep(2)} disabled={screenshots.length === 0}>
              Continue
            </Button>
          </div>
        </Panel>
      )}

      {step === 2 && hasSource && (
        <Panel
          title="Options"
          subtitle={
            kind === 'sop' && file
              ? `${kindLabel} · ${file.name}`
              : `${kindLabel} · ${screenshots.length} screenshot${screenshots.length > 1 ? 's' : ''}`
          }
          tips={
            kind === 'sop'
              ? [
                  'Title: the name of the task, as your team would search for it (e.g. “Book a supplier invoice”).',
                  'Language: the procedure and the voice-over are written in it, whatever language you spoke.',
                  'Voice: listen with ▶ before choosing. The tone changes how the text is written and read.',
                ]
              : [
                  'Brief: the more concrete, the better the script: who it is for, the main benefit, a figure, the call to action.',
                  'Length: 30 s for social media, 60 s for a landing page or a demo.',
                  'Voice: listen with ▶ before choosing. Music is composed for your video.',
                ]
          }
        >
          <Card>
            <div className={styles.form}>
              <Field
                label={kind === 'sop' ? 'Title' : 'Product name'}
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
                    label="Your product: what it does, for whom, the message and the call to action"
                    multiline
                    rows={4}
                    placeholder="e.g. Invoice tool for accounting firms: invoices are booked in one click instead of 10 minutes. End with “Book a demo”."
                    required
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
                <Button
                  type="button"
                  onClick={() => setStep(3)}
                  disabled={!title.trim() || (kind === 'marketing' && !brief.trim())}
                >
                  Continue
                </Button>
              </div>
            </div>
          </Card>
        </Panel>
      )}

      {step === 3 && hasSource && (
        <Panel
          title="Ready to generate"
          subtitle="It takes a few minutes. You can close the page: the result appears in your library."
          tips={
            kind === 'sop'
              ? [
                  'The AI watches and listens to your video, and lists every step.',
                  'It writes the procedure, with the best screenshot for each step.',
                  'It edits a narrated video of 4 min max, in sync with the screen.',
                  'If anything fails, your credits are refunded automatically.',
                ]
              : [
                  'The AI writes a storyboard from your screenshots and your brief.',
                  'Each scene is designed as an animated mockup of your product.',
                  'Voice-over, captions and music are added, in a 1080p video.',
                  'If anything fails, your credits are refunded automatically.',
                ]
          }
        >
          <Card>
            <dl className={styles.summary}>
              <dt>Type</dt>
              <dd>{kindLabel}</dd>
              <dt>Title</dt>
              <dd>{title}</dd>
              {kind === 'sop' && file ? (
                <>
                  <dt>Video</dt>
                  <dd>
                    {file.name} · {Math.floor(duration / 60)}:
                    {String(Math.round(duration % 60)).padStart(2, '0')}
                  </dd>
                </>
              ) : (
                <>
                  <dt>Screenshots</dt>
                  <dd>{screenshots.length}</dd>
                </>
              )}
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
                <span className={styles.notice}>Uploading… {uploading}%</span>
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
  tips,
  children,
}: {
  title: string
  subtitle: string
  /** Conseils courts affichés sous le titre. */
  tips?: string[]
  children: ReactNode
}) {
  return (
    <section className={styles.panel}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.subtitle}>{subtitle}</p>
          {tips && tips.length > 0 && (
            <ul className={styles.tips}>
              {tips.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {children}
    </section>
  )
}

/** Étapes numérotées ; on peut revenir en arrière en cliquant sur une étape passée. */
function Stepper({
  labels,
  current,
  onGo,
}: {
  labels: string[]
  current: number
  onGo: (step: number) => void
}) {
  return (
    <ol className={styles.stepper}>
      {labels.map((label, i) => (
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
