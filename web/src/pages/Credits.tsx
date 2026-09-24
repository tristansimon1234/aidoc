import { useState } from 'react'
import { api, type Me } from '../api'
import { Badge, Button, Card, Spinner } from '../ui/design-system/components'
import styles from './pages.module.css'

export function Credits({ me }: { me: Me | null }) {
  const [error, setError] = useState<string | null>(null)

  async function go(action: () => Promise<{ url: string }>) {
    setError(null)
    try {
      window.location.href = (await action()).url
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (!me) return <Spinner />

  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Crédits</h1>
          <p className={styles.subtitle}>
            1 crédit = une vidéo de {me.minutesPerCredit} min maximum : procédure, captures et vidéo
            commentée comprises.
          </p>
        </div>
      </div>

      <Card>
        <p className={styles.subtitle}>Solde</p>
        <p className={styles.balance}>{me.credits}</p>
        {me.hasBillingAccount && (
          <button className={styles.link} onClick={() => void go(api.billingPortal)}>
            Factures et abonnement
          </button>
        )}
      </Card>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Recharger</h2>
        {me.offers.length === 0 ? (
          <p className={styles.notice}>Le paiement n’est pas encore ouvert.</p>
        ) : (
          <div className={styles.offers}>
            {me.offers.map((o) => (
              <Card key={o.id} className={styles.offer}>
                <div>
                  <Badge color={o.recurring ? 'purple' : 'green'}>
                    {o.recurring ? 'Abonnement' : 'Pack'}
                  </Badge>
                </div>
                <p className={styles.price}>
                  {o.price ?? '—'}
                  {o.recurring && <span className={styles.mono}> / mois</span>}
                </p>
                <p className={styles.notice}>
                  {o.credits} crédits{o.recurring ? ' chaque mois' : ', sans date limite'}
                </p>
                <Button onClick={() => void go(() => api.checkout(o.id))}>
                  {o.recurring ? 'S’abonner' : 'Acheter'}
                </Button>
              </Card>
            ))}
          </div>
        )}
        {error && <p className={styles.error}>{error}</p>}
      </section>
    </>
  )
}
