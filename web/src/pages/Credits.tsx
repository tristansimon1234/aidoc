import { useState } from 'react'
import { api, type Me, type Offer } from '../api'

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

  if (!me) return null

  return (
    <section>
      <h2>Crédits</h2>
      <p className="lead">
        Il vous reste <strong>{me.credits}</strong> crédit{me.credits > 1 ? 's' : ''}.
        <br />1 crédit = une vidéo de {me.minutesPerCredit} min maximum (texte, captures et voix off
        compris).
      </p>

      {me.offers.length === 0 ? (
        <p className="muted">Le paiement n'est pas encore ouvert.</p>
      ) : (
        <div className="offers">
          {me.offers.map((o: Offer) => (
            <div key={o.id} className="card">
              <h3>{o.recurring ? 'Abonnement' : 'Pack'}</h3>
              <p className="price">
                {o.price ?? '—'}
                {o.recurring && <span className="muted"> / mois</span>}
              </p>
              <p>
                {o.credits} crédits{o.recurring ? ' chaque mois' : ', sans limite de durée'}
              </p>
              <button className="primary" onClick={() => go(() => api.checkout(o.id))}>
                {o.recurring ? "S'abonner" : 'Acheter'}
              </button>
            </div>
          ))}
        </div>
      )}

      {me.hasBillingAccount && (
        <p>
          <button className="link" onClick={() => go(api.billingPortal)}>
            Factures et abonnement
          </button>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
