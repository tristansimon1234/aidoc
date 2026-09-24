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
const STEPS = [
  { label: 'Préparation de la vidéo', estimatedSeconds: 20 },
  { label: 'Analyse de la vidéo', estimatedSeconds: 60 },
  { label: 'Captures d’écran', estimatedSeconds: 10 },
  { label: 'Rédaction de la procédure', estimatedSeconds: 30 },
  { label: 'Montage de la vidéo', estimatedSeconds: 20 },
  { label: 'Voix off', estimatedSeconds: 60 },
  { label: 'Finalisation', estimatedSeconds: 10 },
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
      title: 'Supprimer cette procédure ?',
      message: 'Le texte, les captures et la vidéo seront effacés définitivement.',
      confirmLabel: 'Supprimer',
    })
    if (!ok) return
    await api.deleteSop(sop.id)
    navigate('/')
  }

  const header = (
    <div className={`${styles.header} no-print`}>
      {/* Une fois prête, le titre est celui de la procédure elle-même (dans le document). */}
      {sop.status === 'ready' ? (
        <p className={styles.subtitle}>{new Date(sop.createdAt).toLocaleDateString('fr-FR')}</p>
      ) : (
        <div>
          <h1 className={styles.title}>{sop.title}</h1>
          <p className={styles.subtitle}>{new Date(sop.createdAt).toLocaleDateString('fr-FR')}</p>
        </div>
      )}
      {sop.status === 'ready' && (
        <div className={styles.actions}>
          <Button onClick={() => void copy()}>
            {copied ? 'Copié ✓' : 'Copier pour Notion / Docs'}
          </Button>
          <Button variant="secondary" onClick={() => window.print()}>
            PDF
          </Button>
          <Button variant="secondary" onClick={downloadMarkdown}>
            Markdown
          </Button>
          <Button variant="ghost" onClick={() => void remove()}>
            Supprimer
          </Button>
        </div>
      )}
    </div>
  )

  if (sop.status === 'processing') {
    const steps = STEPS.filter((s) => sop.voice !== 'none' || s.label !== 'Voix off')
    const active = Math.max(
      0,
      steps.findIndex((s) => s.label === sop.progress),
    )
    return (
      <>
        {header}
        <ProgressLoader steps={steps} activeStep={active} statusMessage={sop.progress} />
        <p className={styles.notice} style={{ marginTop: 'var(--space-md)' }}>
          Vous pouvez fermer cette page : la génération continue.
        </p>
      </>
    )
  }

  if (sop.status !== 'ready') {
    return (
      <>
        {header}
        <Card>
          <p className={styles.error}>
            {sop.error ?? "La vidéo n'a pas été envoyée jusqu'au bout."}
          </p>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => void remove()}>
              Supprimer
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
      <div className={styles.doc}>
        <Card>
          <div ref={doc}>
            <MarkdownRenderer content={sop.markdown ?? ''} lang={sop.language} />
          </div>
        </Card>
      </div>
      {dialog}
    </>
  )
}
