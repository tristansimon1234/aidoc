import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, downloadFile, type Sop } from '../api'
import {
  Button,
  Card,
  MarkdownRenderer,
  ProgressLoader,
  Spinner,
  useConfirmDialog,
} from '../ui/design-system/components'
import { NarratedPlayer } from '../ui/NarratedPlayer'
import styles from './pages.module.css'

/** Étapes affichées pendant la génération (libellés = `progress` envoyé par le serveur). */
const SOP_STEPS = [
  {
    label: 'Preparing the video',
    text: 'Converted to a light format that is quick to analyze.',
    estimatedSeconds: 20,
  },
  {
    label: 'Analyzing the video',
    text: 'The AI watches and listens: it transcribes what you say and lists every step.',
    estimatedSeconds: 60,
  },
  {
    label: 'Taking screenshots',
    text: 'For each step, the clearest frame is picked among several.',
    estimatedSeconds: 10,
  },
  {
    label: 'Writing the procedure',
    text: 'Step-by-step instructions, with your explanations, warnings and checks.',
    estimatedSeconds: 30,
  },
  {
    label: 'Editing the video',
    text: 'Dead time is cut out to keep a video of 4 min max.',
    estimatedSeconds: 20,
  },
  {
    label: 'Recording the voice-over',
    text: 'A short commentary for each passage, in sync with the screen.',
    estimatedSeconds: 60,
  },
  { label: 'Finishing', text: 'Saving the procedure and the video.', estimatedSeconds: 10 },
]

const MARKETING_STEPS = [
  {
    label: 'Writing the storyboard',
    text: 'From your screenshots and brief: the story, the hook, the colors of your product.',
    estimatedSeconds: 40,
  },
  {
    label: 'Recording the voice-over',
    text: 'One line per scene; each scene lasts as long as its line.',
    estimatedSeconds: 20,
  },
  {
    label: 'Designing the scenes',
    text: 'Each scene is coded as an animated mockup, tested, then reviewed on its images.',
    estimatedSeconds: 300,
  },
  {
    label: 'Rendering the video',
    text: 'The scenes are assembled in 1080p, with word-by-word captions.',
    estimatedSeconds: 120,
  },
  {
    label: 'Mixing the sound',
    text: 'Voice-over and background music are mixed together.',
    estimatedSeconds: 30,
  },
  { label: 'Finishing', text: 'Saving the video.', estimatedSeconds: 5 },
]

export function SopPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [sop, setSop] = useState<Sop | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const doc = useRef<HTMLDivElement>(null)
  const { dialog, confirm } = useConfirmDialog()

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const load = () =>
      api
        .getSop(id)
        .then((s) => {
          setSop(s)
          if (s.status === 'processing') timer = setTimeout(load, 3000)
        })
        .catch((err: Error) => setError(err.message))
    void load()
    return () => clearTimeout(timer)
  }, [id])

  if (error) return <p className={styles.error}>{error}</p>
  if (!sop) return <Spinner />
  const marketing = sop.kind === 'marketing'

  async function copy() {
    if (!doc.current || !sop?.markdown) return
    // Copie « riche » : se colle avec la mise en forme et les images dans Notion, Google Docs, Confluence…
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([doc.current.innerHTML], { type: 'text/html' }),
        'text/plain': new Blob([sop.markdown], { type: 'text/plain' }),
      }),
    ])
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function downloadMarkdown() {
    if (!sop?.markdown) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([sop.markdown], { type: 'text/markdown' }))
    a.download = `${sop.title}.md`
    a.click()
  }

  async function downloadVideo() {
    if (!sop?.videoUrl) return
    setDownloading(true)
    try {
      await downloadFile(sop.videoUrl, `${sop.title}.mp4`)
    } catch {
      // Dernier recours : ouvrir la vidéo, le navigateur propose de l'enregistrer.
      window.open(sop.videoUrl, '_blank')
    } finally {
      setDownloading(false)
    }
  }

  async function remove() {
    if (!sop) return
    const ok = await confirm({
      title: marketing ? 'Delete this marketing video?' : 'Delete this procedure?',
      message: marketing
        ? 'The video will be permanently deleted.'
        : 'The text, screenshots and video will be permanently deleted.',
      confirmLabel: 'Delete',
    })
    if (!ok) return
    await api.deleteSop(sop.id)
    navigate(marketing ? '/?tab=marketing' : '/')
  }

  const header = (
    <div className={`${styles.header} no-print`}>
      {/* Une fois prête, le titre d'une SOP est celui du document lui-même. */}
      {sop.status === 'ready' && !marketing ? (
        <p className={styles.subtitle}>{new Date(sop.createdAt).toLocaleDateString('en-GB')}</p>
      ) : (
        <div>
          <h1 className={styles.title}>{sop.title}</h1>
          <p className={styles.subtitle}>{new Date(sop.createdAt).toLocaleDateString('en-GB')}</p>
        </div>
      )}
      {sop.status === 'ready' && marketing && (
        <div className={styles.actions}>
          {sop.videoUrl && (
            <Button onClick={() => void downloadVideo()} disabled={downloading}>
              {downloading ? 'Downloading…' : 'Download video'}
            </Button>
          )}
          <Button variant="ghost" onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      )}
      {sop.status === 'ready' && !marketing && (
        <div className={styles.actions}>
          <Button onClick={() => void copy()}>
            {copied ? 'Copied ✓' : 'Copy for Notion / Docs'}
          </Button>
          <Button variant="secondary" onClick={() => window.print()}>
            PDF
          </Button>
          <Button variant="secondary" onClick={downloadMarkdown}>
            Markdown
          </Button>
          {sop.videoUrl && (
            <Button variant="secondary" onClick={() => void downloadVideo()} disabled={downloading}>
              {downloading ? 'Downloading…' : 'Video'}
            </Button>
          )}
          <Button variant="ghost" onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      )}
    </div>
  )

  if (sop.status === 'processing') {
    const steps = marketing
      ? MARKETING_STEPS
      : SOP_STEPS.filter((s) => sop.voice !== 'none' || s.label !== 'Recording the voice-over')
    const active = Math.max(
      0,
      // « Designing the scenes (2/6) » : le compteur suit le libellé.
      steps.findIndex((s) => sop.progress?.startsWith(s.label)),
    )
    return (
      <>
        {header}
        <ProgressLoader steps={steps} activeStep={active} statusMessage={sop.progress} />
        <ol className={styles.stages}>
          {steps.map((s, i) => (
            <li
              key={s.label}
              className={`${styles.stage} ${i < active ? styles.stageDone : ''} ${i === active ? styles.stageActive : ''}`}
            >
              <span className={styles.stageMark}>{i < active ? '✓' : ''}</span>
              <span>
                <span className={styles.stageName}>{s.label}</span>
                <span className={styles.stageText}>{s.text}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className={styles.notice} style={{ marginTop: 'var(--space-md)' }}>
          You can close this page: generation keeps running.
        </p>
      </>
    )
  }

  if (sop.status !== 'ready') {
    return (
      <>
        {header}
        <Card>
          <p className={styles.error}>{sop.error ?? 'The video upload did not complete.'}</p>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => void remove()}>
              Delete
            </Button>
          </div>
        </Card>
        {dialog}
      </>
    )
  }

  return (
    <>
      {header}
      {sop.videoUrl && (
        <div className="no-print">
          <NarratedPlayer videoUrl={sop.videoUrl} narrated={sop.voice !== 'none'} />
        </div>
      )}
      {!marketing && (
        <div className={styles.doc}>
          <Card>
            <div ref={doc}>
              <MarkdownRenderer content={sop.markdown ?? ''} lang={sop.language} />
            </div>
          </Card>
        </div>
      )}
      {dialog}
    </>
  )
}
