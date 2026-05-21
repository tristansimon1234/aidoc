import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Spinner } from '../../design-system/components/index.js'
import { api, ApiError, type CreditsDTO } from '../../shared/api/client.js'
import styles from './Billing.module.css'

/**
 * Credit purchase surface. Three pack tiers — Stripe Price IDs come from
 * the backend (env-configured), pricing labels from the same source.
 * Click → Stripe Checkout Session → user returns here or to /dashboard
 * after payment, webhook credits the balance.
 */
export function Billing(): React.ReactElement {
  const navigate = useNavigate()
  const [credits, setCredits] = useState<CreditsDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingPack, setPendingPack] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.credits.get()
      setCredits(res)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const checkout = async (packId: 'starter' | 'pro' | 'agency'): Promise<void> => {
    setPendingPack(packId)
    setError(null)
    try {
      const { url } = await api.credits.checkout(packId)
      // Hard navigate to Stripe Checkout — no SPA history needed.
      window.location.href = url
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message)
      setPendingPack(null)
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/dashboard" className={styles.back}>← Dashboard</Link>
      </header>

      <main className={styles.main}>
        <h1 className={styles.title}>Buy credits</h1>
        <p className={styles.subtitle}>Each video costs 1 credit. No subscription, no expiry.</p>

        {loading ? (
          <div className={styles.loadingBox}><Spinner size="md" /></div>
        ) : (
          <>
            <div className={styles.balance}>
              <span className={styles.balanceLabel}>Current balance</span>
              <span className={styles.balanceValue}>{credits?.balance ?? 0} credit{(credits?.balance ?? 0) === 1 ? '' : 's'}</span>
            </div>

            <div className={styles.packs}>
              {credits?.packs.map((p) => (
                <div key={p.id} className={`${styles.pack} ${p.id === 'pro' ? styles.packFeatured : ''}`}>
                  {p.id === 'pro' && <div className={styles.featuredBadge}>Best value</div>}
                  <h2 className={styles.packName}>{p.name}</h2>
                  <div className={styles.packPrice}>
                    <span className={styles.priceMain}>${(p.priceCents / 100).toFixed(0)}</span>
                  </div>
                  <p className={styles.packCredits}>
                    {p.credits} credit{p.credits === 1 ? '' : 's'}
                  </p>
                  <p className={styles.packPerCredit}>
                    ≈ ${(p.priceCents / 100 / p.credits).toFixed(2)} per video
                  </p>
                  <Button
                    variant={p.id === 'pro' ? 'primary' : 'ghost'}
                    onClick={() => void checkout(p.id as 'starter' | 'pro' | 'agency')}
                    disabled={pendingPack !== null}
                  >
                    {pendingPack === p.id ? 'Redirecting…' : 'Buy'}
                  </Button>
                </div>
              ))}
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.foot}>
              <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')}>
                Back to dashboard
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
