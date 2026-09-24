import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type Sop } from '../api'

const STEPS = [
  'Préparation de la vidéo',
  'Analyse de la vidéo',
  'Captures d’écran',
  'Rédaction de la procédure',
  'Voix off',
  'Finalisation',
]

export function SopPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [sop, setSop] = useState<Sop | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const article = useRef<HTMLElement>(null)

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

  if (error) return <p className="error">{error}</p>
  if (!sop) return <p className="muted">Chargement…</p>

  async function copy() {
    if (!article.current || !sop?.markdown) return
    // Copie « riche » : se colle avec la mise en forme et les images dans Notion, Google Docs, Confluence…
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([article.current.innerHTML], { type: 'text/html' }),
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
    if (!sop || !confirm('Supprimer cette procédure et sa vidéo ?')) return
    await api.deleteSop(sop.id)
    navigate('/')
  }

  if (sop.status === 'processing') {
    const steps = STEPS.filter((s) => sop.voice !== 'none' || s !== 'Voix off')
    const current = steps.indexOf(sop.progress ?? '')
    return (
      <section className="card">
        <h2>{sop.title}</h2>
        <p className="muted">
          Génération en cours, comptez quelques minutes. Vous pouvez fermer cette page.
        </p>
        <ol className="progress">
          {steps.map((s, i) => (
            <li key={s} className={i < current ? 'done' : i === current ? 'active' : ''}>
              {s}
            </li>
          ))}
        </ol>
      </section>
    )
  }

  if (sop.status !== 'ready') {
    return (
      <section className="card">
        <h2>{sop.title}</h2>
        <p className="error">{sop.error ?? "La vidéo n'a pas été envoyée jusqu'au bout."}</p>
        <button onClick={remove}>Supprimer</button>
      </section>
    )
  }

  return (
    <>
      <div className="toolbar no-print">
        <button className="primary" onClick={copy}>
          {copied ? 'Copié ✓' : 'Copier pour Notion / Docs'}
        </button>
        <button onClick={() => window.print()}>PDF</button>
        <button onClick={downloadMarkdown}>Markdown</button>
        {sop.videoUrl && (
          <a className="button" href={sop.videoUrl} download>
            Vidéo
          </a>
        )}
        <button className="link danger-text" onClick={remove}>
          Supprimer
        </button>
      </div>

      {sop.videoUrl && <video className="no-print" src={sop.videoUrl} controls />}

      <article ref={article} className="sop">
        <Markdown remarkPlugins={[remarkGfm]}>{sop.markdown ?? ''}</Markdown>
      </article>
    </>
  )
}
