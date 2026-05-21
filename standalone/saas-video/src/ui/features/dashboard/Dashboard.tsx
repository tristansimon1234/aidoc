import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, EmptyState, Spinner } from '../../design-system/components/index.js'
import { api, ApiError, type MarketingVideoListItemDTO, type BrandDTO, type CreditsDTO } from '../../shared/api/client.js'
import { useAuth } from '../../shared/hooks/useAuth.js'
import { GenerateModal } from '../generate/GenerateModal.js'
import styles from './Dashboard.module.css'

/**
 * Dashboard — landing surface after login. Three responsibilities:
 *   - show the user's credit balance + a quick "Buy more" link
 *   - list every marketing video they've generated (gallery cards)
 *   - launch the generate flow via the modal stepper
 *
 * If the user has no brand yet, we hard-redirect to /onboarding instead of
 * showing the generate CTA — the API would reject a video creation without
 * a brand anyway, but catching it here gives a cleaner UX.
 */
export function Dashboard(): React.ReactElement {
  const navigate = useNavigate()
  const { signOut } = useAuth()
  const [items, setItems] = useState<MarketingVideoListItemDTO[]>([])
  const [credits, setCredits] = useState<CreditsDTO | null>(null)
  const [brands, setBrands] = useState<BrandDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [videos, creditsRes, brandsRes] = await Promise.all([
        api.marketingVideos.list(),
        api.credits.get(),
        api.brands.list(),
      ])
      setItems(videos.items)
      setCredits(creditsRes)
      setBrands(brandsRes.items)
    } catch (err) {
      // If the request 401s (token expired), useAuth will flip — no need
      // to do anything here. Other errors are unusual; log them.
      if (!(err instanceof ApiError) || err.status !== 401) {
        console.error('[dashboard] refresh failed', err)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // First-run guard: send the user to onboarding if they have no brand yet.
  // We wait for the fetch to complete to avoid bouncing them around during
  // the initial render.
  useEffect(() => {
    if (!loading && brands.length === 0) navigate('/onboarding', { replace: true })
  }, [loading, brands.length, navigate])

  const lowCredit = (credits?.balance ?? 0) === 0

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <Link to="/" className={styles.brandLink}>SaaS Video</Link>
        </div>
        <div className={styles.headerActions}>
          <Link to="/billing" className={styles.creditBadge}>
            <span className={styles.creditCount}>{credits?.balance ?? 0}</span>
            <span className={styles.creditLabel}>credits</span>
          </Link>
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>Sign out</Button>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.titleRow}>
          <div>
            <h1 className={styles.title}>Your videos</h1>
            <p className={styles.subtitle}>Generate a new product video, or pick one to refine.</p>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              if (lowCredit) { navigate('/billing'); return }
              setModalOpen(true)
            }}
          >
            {lowCredit ? 'Buy credits' : 'New video'}
          </Button>
        </div>

        {loading ? (
          <div className={styles.loadingBox}><Spinner size="md" /></div>
        ) : items.length === 0 ? (
          <EmptyState
            title="No videos yet"
            description={lowCredit
              ? 'Buy a credit pack to generate your first video.'
              : 'Click ‘New video’ to generate your first one from a brief.'}
          />
        ) : (
          <div className={styles.grid}>
            {items.map((v) => <VideoCard key={v.id} item={v} />)}
          </div>
        )}
      </main>

      {modalOpen && credits && (
        <GenerateModal
          brands={brands}
          onClose={() => setModalOpen(false)}
          onSuccess={() => { setModalOpen(false); void refresh() }}
        />
      )}
    </div>
  )
}

function VideoCard({ item }: { item: MarketingVideoListItemDTO }): React.ReactElement {
  const statusLabel: Record<MarketingVideoListItemDTO['renderStatus'], string> = {
    pending: 'Pending',
    idle: 'Idle',
    generating: 'Generating…',
    rendering: 'Rendering…',
    ready: 'Ready',
    failed: 'Failed',
  }
  return (
    <div className={styles.card}>
      <div className={styles.cardMedia}>
        {item.videoUrl ? (
          <video controls className={styles.cardVideo} poster={item.thumbnailUrl ?? undefined}>
            <source src={item.videoUrl} type="video/mp4" />
          </video>
        ) : item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" className={styles.cardThumb} />
        ) : (
          <div className={styles.cardPlaceholder}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </div>
        )}
      </div>
      <div className={styles.cardBody}>
        <div className={styles.cardTitle}>{item.title}</div>
        <div className={styles.cardMeta}>
          <span>{statusLabel[item.renderStatus]}</span>
          {item.durationSeconds && <span>· {item.durationSeconds.toFixed(0)}s</span>}
          <span>· {new Date(item.createdAt).toLocaleDateString()}</span>
        </div>
        {item.renderError && <p className={styles.cardError}>{item.renderError}</p>}
      </div>
    </div>
  )
}
