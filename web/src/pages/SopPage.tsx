import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type Sop } from '../api'
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
  { label: 'Preparing the video', estimatedSeconds: 20 },
  { label: 'Analyzing the video', estimatedSeconds: 60 },
  { label: 'Taking screenshots', estimatedSeconds: 10 },
  { label: 'Writing the procedure', estimatedSeconds: 30 },
  { label: 'Editing the video', estimatedSeconds: 20 },
  { label: 'Recording the voice-over', estimatedSeconds: 60 },
  { label: 'Finishing', estimatedSeconds: 10 },
]

const MARKETING_STEPS = [
  { label: 'Writing the storyboard', estimatedSeconds: 40 },
  { label: 'Recording the voice-over', estimatedSeconds: 20 },
  { label: 'Designing the scenes', estimatedSeconds: 300 },
  { label: 'Rendering the video', estimatedSeconds: 120 },
  { label: 'Mixing the sound', estimatedSeconds: 30 },
  { label: 'Finishing', estimatedSeconds: 5 },
]

export function SopPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [sop, setSop] = useState<Sop | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
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
            <a href={sop.videoUrl} download={`${sop.title}.mp4`}>
              <Button>Download video</Button>
            </a>
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
