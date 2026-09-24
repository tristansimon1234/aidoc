// Paiement Stripe : pack de crédits (paiement unique) ou abonnement mensuel.
import Stripe from 'stripe'
import { env } from './env.js'
import * as db from './db.js'
import { OFFERS, type OfferId } from './credits.js'

const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null

function priceId(offer: OfferId): string | undefined {
  return offer === 'pack' ? env.STRIPE_PRICE_PACK : env.STRIPE_PRICE_MONTHLY
}

export interface OfferView {
  id: OfferId
  credits: number
  recurring: boolean
  price: string | null
}

/** Offres disponibles avec leur prix lu dans Stripe (mis en cache 10 min). */
let offersCache: { at: number; offers: OfferView[] } | null = null
export async function listOffers(): Promise<OfferView[]> {
  if (!stripe) return []
  if (offersCache && Date.now() - offersCache.at < 10 * 60_000) return offersCache.offers
  const offers: OfferView[] = []
  for (const id of Object.keys(OFFERS) as OfferId[]) {
    const pid = priceId(id)
    if (!pid) continue
    const price = await stripe.prices.retrieve(pid)
    const amount =
      price.unit_amount === null
        ? null
        : new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency }).format(
            price.unit_amount / 100,
          )
    offers.push({
      id,
      credits: OFFERS[id].credits,
      recurring: OFFERS[id].mode === 'subscription',
      price: amount,
    })
  }
  offersCache = { at: Date.now(), offers }
  return offers
}

async function customerFor(userId: string): Promise<string> {
  if (!stripe) throw new Error('Stripe is not configured')
  const account = await db.getAccount(userId)
  if (account.stripeCustomerId) return account.stripeCustomerId
  const customer = await stripe.customers.create({
    email: (await db.userEmail(userId)) ?? undefined,
    metadata: { userId },
  })
  await db.setStripeCustomerId(userId, customer.id)
  return customer.id
}

export async function createCheckout(userId: string, offer: OfferId): Promise<string> {
  const pid = priceId(offer)
  if (!stripe || !pid) throw new Error('Offer unavailable')
  const session = await stripe.checkout.sessions.create({
    mode: OFFERS[offer].mode,
    customer: await customerFor(userId),
    line_items: [{ price: pid, quantity: 1 }],
    metadata: { userId, offer },
    allow_promotion_codes: true,
    success_url: `${env.APP_URL}/?paid=1`,
    cancel_url: `${env.APP_URL}/`,
  })
  if (!session.url) throw new Error('Stripe returned no URL')
  return session.url
}

/** Portail client Stripe : factures, carte, résiliation de l'abonnement. */
export async function createPortal(userId: string): Promise<string> {
  if (!stripe) throw new Error('Stripe is not configured')
  const session = await stripe.billingPortal.sessions.create({
    customer: await customerFor(userId),
    return_url: `${env.APP_URL}/`,
  })
  return session.url
}

/**
 * Webhook Stripe.
 * - checkout.session.completed (paiement unique) → +10 crédits
 * - invoice.paid (chaque mois de l'abonnement, y compris le 1er) → +30 crédits
 * Chaque évènement est crédité une seule fois (ref unique en base).
 */
export async function handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe is not configured')
  const event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET)

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    if (session.mode !== 'payment' || session.payment_status !== 'paid') return
    const userId = session.metadata?.userId
    if (!userId) return
    await db.applyCredits(userId, OFFERS.pack.credits, 'purchase:pack', `stripe:${session.id}`)
    return
  }

  if (event.type === 'invoice.paid') {
    const invoice = event.data.object
    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
    if (!customerId || !invoice.id) return
    const userId = await db.findUserIdByStripeCustomer(customerId)
    if (!userId) return
    await db.applyCredits(
      userId,
      OFFERS.monthly.credits,
      'purchase:monthly',
      `stripe:${invoice.id}`,
    )
  }
}

export function isBillingEnabled(): boolean {
  return stripe !== null
}
