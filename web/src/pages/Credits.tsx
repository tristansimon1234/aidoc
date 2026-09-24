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
          <h1 className={styles.title}>Credits</h1>
          <p className={styles.subtitle}>
            SOP: 1 credit per {me.minutesPerCredit} min of video (procedure, screenshots and
            narrated video included). Marketing video: {me.marketingCredits} credits.
          </p>
        </div>
      </div>

      <Card>
        <p className={styles.subtitle}>Balance</p>
        <p className={styles.balance}>{me.credits}</p>
        {me.hasBillingAccount && (
          <button className={styles.link} onClick={() => void go(api.billingPortal)}>
            Invoices and subscription
          </button>
        )}
      </Card>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Top up</h2>
        {me.offers.length === 0 ? (
          <p className={styles.notice}>Payments are not open yet.</p>
        ) : (
          <div className={styles.offers}>
            {me.offers.map((o) => (
              <Card key={o.id} className={styles.offer}>
                <div>
                  <Badge color={o.recurring ? 'purple' : 'green'}>
                    {o.recurring ? 'Subscription' : 'Pack'}
                  </Badge>
                </div>
                <p className={styles.price}>
                  {o.price ?? '—'}
                  {o.recurring && <span className={styles.mono}> / month</span>}
                </p>
                <p className={styles.notice}>
                  {o.credits} credits{o.recurring ? ' every month' : ', never expire'}
                </p>
                <Button onClick={() => void go(() => api.checkout(o.id))}>
                  {o.recurring ? 'Subscribe' : 'Buy'}
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
