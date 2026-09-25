import { useEffect, useState } from 'react'
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
          {shown.map((s) => (
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
