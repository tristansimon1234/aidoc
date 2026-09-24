// L'application Express : utilisée telle quelle par Vercel (api/index.ts) et en local (server/index.ts).
import express, { type NextFunction, type Request, type Response } from 'express'
import { ZodError } from 'zod'
import { api } from './routes.js'
import { handleWebhook } from './billing.js'

export const app = express()

// Stripe a besoin du corps brut pour vérifier la signature : route déclarée avant express.json().
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    await handleWebhook(req.body as Buffer, String(req.headers['stripe-signature'] ?? ''))
    res.json({ received: true })
  } catch (err) {
    console.error('[stripe] webhook refusé', (err as Error).message)
    res.status(400).json({ error: 'Invalid webhook' })
  }
})

app.use(express.json({ limit: '1mb' }))
app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})
app.use('/api', api)

app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request', details: err.issues })
    return
  }
  console.error(err)
  res.status(500).json({ error: 'Server error' })
})
