import { Router } from 'express'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import Stripe from 'stripe'
import { env } from '../../shared/config/env.js'
import { ValidationError, AppError } from '../../shared/middleware/error.middleware.js'
import { getUserId, authMiddleware } from '../../shared/middleware/auth.middleware.js'
import { addCredits, findCreditsForUser, setStripeCustomerId } from './credits.repository.js'
import { supabase } from '../../shared/db/supabase.client.js'

/**
 * Credit packs — single source of truth. Keep aligned with the Stripe
 * products in your dashboard; the `priceId` is what Checkout uses, the
 * `credits` is what the webhook adds on success. The webhook uses the
 * `priceId` (delivered as part of the session line items) to look up
 * the credit count, NOT a client-provided number — that would be trivially
 * forgeable.
 */
export interface CreditPack {
  id: string
  name: string
  credits: number
  priceCents: number
  /** Stripe Price ID. Wire up in the Stripe dashboard, paste here. */
  priceId: string
}

export const CREDIT_PACKS: CreditPack[] = [
  // Defaults — replace priceId with your real Stripe Price IDs.
  { id: 'starter', name: 'Starter pack', credits: 5,  priceCents: 1900,  priceId: process.env.STRIPE_PRICE_STARTER ?? '' },
  { id: 'pro',     name: 'Pro pack',     credits: 20, priceCents: 5900,  priceId: process.env.STRIPE_PRICE_PRO ?? '' },
  { id: 'agency',  name: 'Agency pack',  credits: 100,priceCents: 19900, priceId: process.env.STRIPE_PRICE_AGENCY ?? '' },
]

const PRICE_TO_PACK = new Map(CREDIT_PACKS.map((p) => [p.priceId, p]))

const CheckoutBodySchema = z.object({ packId: z.enum(['starter', 'pro', 'agency']) })

function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError('Stripe is not configured. Set STRIPE_SECRET_KEY.', 'STRIPE_NOT_CONFIGURED', 503)
  }
  return new Stripe(env.STRIPE_SECRET_KEY)
}

// =====================================================================
// AUTHED ROUTER — mounted at /api/credits
// =====================================================================
export const creditsRouter = Router()

/** GET /api/credits — current balance + total bought + pack catalog */
creditsRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const credits = await findCreditsForUser(userId)
      res.status(200).json({
        balance: credits?.balance ?? 0,
        totalBought: credits?.totalBought ?? 0,
        packs: CREDIT_PACKS.map(({ id, name, credits: c, priceCents }) => ({ id, name, credits: c, priceCents })),
      })
    } catch (err) { next(err) }
  })()
})

/** POST /api/credits/checkout — start a Stripe Checkout Session.
 *
 *  The success/cancel URLs come from PUBLIC_APP_URL — required in prod.
 *  The userId is stashed in the session's `client_reference_id` so the
 *  webhook can map the completed payment back to the user without
 *  trusting any client-provided value.
 */
creditsRouter.post('/checkout', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const body = CheckoutBodySchema.safeParse(req.body ?? {})
      if (!body.success) throw new ValidationError(body.error.flatten())
      const pack = CREDIT_PACKS.find((p) => p.id === body.data.packId)
      if (!pack) throw new AppError('Unknown pack', 'UNKNOWN_PACK', 400)
      if (!pack.priceId) {
        throw new AppError(
          `Stripe Price ID for pack "${pack.id}" not configured. Set STRIPE_PRICE_${pack.id.toUpperCase()}.`,
          'PRICE_NOT_CONFIGURED',
          503,
        )
      }

      const credits = await findCreditsForUser(userId)
      const appUrl = env.PUBLIC_APP_URL ?? 'http://localhost:5173'

      // Pull the user's email so Stripe Checkout pre-fills it (and so the
      // receipt goes to the right place even if they're not logged into
      // their Stripe customer portal).
      const { data: authUser } = await supabase.auth.admin.getUserById(userId)
      const email = authUser.user?.email ?? undefined

      const session = await stripe().checkout.sessions.create({
        mode: 'payment',
        line_items: [{ price: pack.priceId, quantity: 1 }],
        client_reference_id: userId,
        // If we already have a Stripe customer, attach the session — keeps
        // all the user's purchases under one Customer object in the
        // dashboard. Otherwise let Stripe create one and we'll capture the
        // id on the webhook.
        ...(credits?.stripeCustomerId
          ? { customer: credits.stripeCustomerId }
          : { customer_email: email }),
        success_url: `${appUrl}/dashboard?checkout=success&pack=${pack.id}`,
        cancel_url: `${appUrl}/billing?checkout=cancelled`,
        metadata: { userId, packId: pack.id, credits: String(pack.credits) },
      })

      res.status(200).json({ url: session.url })
    } catch (err) { next(err) }
  })()
})

// =====================================================================
// PUBLIC WEBHOOK ROUTER — mounted at /api/stripe (NO authMiddleware)
// =====================================================================
//
// Stripe sends events here; we verify the signature against the raw body
// using STRIPE_WEBHOOK_SECRET so a forged caller can't credit themselves
// for free. The body parser is `express.raw` (not JSON) because the
// signature is computed over the raw bytes.
export const stripeWebhookRouter = Router()

stripeWebhookRouter.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        if (!env.STRIPE_WEBHOOK_SECRET) {
          throw new AppError('STRIPE_WEBHOOK_SECRET not configured', 'STRIPE_NOT_CONFIGURED', 503)
        }
        const sig = req.header('stripe-signature')
        if (!sig) {
          res.status(400).json({ error: 'Missing stripe-signature header', code: 'MISSING_SIGNATURE' })
          return
        }

        let event: Stripe.Event
        try {
          event = stripe().webhooks.constructEvent(req.body as Buffer, sig, env.STRIPE_WEBHOOK_SECRET)
        } catch (err) {
          res.status(400).json({ error: `Webhook signature verification failed: ${(err as Error).message}`, code: 'INVALID_SIGNATURE' })
          return
        }

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object
          const userId = session.client_reference_id
          if (!userId) {
            console.warn('[stripe-webhook] checkout.session.completed without client_reference_id')
            res.status(200).json({ received: true })
            return
          }

          // Resolve pack from the metadata we set on Checkout creation.
          // Cross-check with priceId from the expanded line item to defend
          // against tampering — if the metadata says "agency" but the
          // user actually paid for the starter price, we credit starter.
          const expanded = await stripe().checkout.sessions.retrieve(session.id, {
            expand: ['line_items'],
          })
          const lineItem = expanded.line_items?.data[0]
          const priceId = lineItem?.price?.id
          const pack = priceId ? PRICE_TO_PACK.get(priceId) : undefined
          if (!pack) {
            console.warn(`[stripe-webhook] No pack matches priceId=${priceId} — skipping credit grant`)
            res.status(200).json({ received: true })
            return
          }

          const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id
          await addCredits(userId, pack.credits, customerId ?? undefined)
          if (customerId) {
            try { await setStripeCustomerId(userId, customerId) } catch { /* best-effort */ }
          }
          console.log(`[stripe-webhook] Credited user=${userId} pack=${pack.id} credits=${pack.credits}`)
        }

        res.status(200).json({ received: true })
      } catch (err) { next(err) }
    })()
  },
)

// authMiddleware re-export so the router file doesn't need a separate import.
export { authMiddleware }
