import { useEffect, useState, type CSSProperties } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, type Kind, type Sop } from '../api'
import { Button, Card, EmptyState, StatusIndicator } from '../ui/design-system/components'
import type { StatusKey } from '../ui/design-system/tokens'
import styles from './pages.module.css'

const TABS: { id: Kind; label: string; empty: string }[] = [
  { id: 'sop', label: 'SOPs', empty: 'No SOP yet' },
  { id: 'marketing', label: 'Marketing videos', empty: 'No marketing video yet' },
]

/** Accueil : deux onglets (SOPs / vidéos marketing) et le bouton de création. */
export function Home() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab: Kind = params.get('tab') === 'marketing' ? 'marketing' : 'sop'
  const [items, setItems] = useState<Sop[] | null>(null)

  const load = () =>
    api
      .listSops()
      .then(setItems)
      .catch(() => setItems([]))
  useEffect(() => {
    void load()
  }, [])
  // Rafraîchit la liste tant qu'une création est en cours.
  useEffect(() => {
    if (!items?.some((s) => s.status === 'processing')) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [items])

  const current = TABS.find((t) => t.id === tab)!
  const shown = (items ?? []).filter((s) => (s.kind ?? 'sop') === tab)

  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Your library</h1>
          <p className={styles.subtitle}>
            Turn a screen recording into an SOP, or a few screenshots into a marketing video.
          </p>
        </div>
        <Button onClick={() => navigate(`/new?kind=${tab}`)}>
          + New {tab === 'sop' ? 'SOP' : 'marketing video'}
        </Button>
      </div>

      <div className={styles.tabs} role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === tab}
            className={t.id === tab ? styles.tabActive : styles.tab}
            onClick={() => setParams(t.id === 'sop' ? {} : { tab: t.id })}
          >
            {t.label}
            <span className={styles.tabCount}>
              {(items ?? []).filter((s) => (s.kind ?? 'sop') === t.id).length}
            </span>
          </button>
        ))}
      </div>

      {items === null ? null : shown.length === 0 ? (
        <Card>
          <EmptyState
            title={current.empty}
            description={
              tab === 'sop'
                ? 'Record your screen or upload a video to create one.'
                : 'Upload a few screenshots of your product to create one.'
            }
            action={
              <Link to={`/new?kind=${tab}`}>
                <Button variant="secondary">Create one</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className={styles.grid}>
          {shown.map((s, i) => (
            <Card
              key={s.id}
              className={styles.gridItem}
              style={{ '--i': i } as CSSProperties}
              onClick={() => navigate(`/sop/${s.id}`)}
            >
              <span className={styles.cardKind}>
                {s.kind === 'marketing' ? <FilmIcon /> : <DocIcon />}
              </span>
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
    </>
  )
}

export function DocIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  )
}

export function FilmIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <path d="m10 9 5 3-5 3z" />
    </svg>
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
