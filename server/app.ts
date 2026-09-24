// L'application Express : utilisée telle quelle par Vercel (api/index.ts) et en local (server/index.ts).
import express, { type NextFunction, type Request, type Response } from 'express'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ZodError } from 'zod'
import { api } from './routes.js'
import { handleWebhook } from './billing.js'
import { isLocalMode } from './db.js'
import { LOCAL_FILES_DIR, localFilePath } from './db.local.js'

export const app = express()
// Derrière le proxy de Railway / Vercel : req.protocol reflète https (en-tête X-Forwarded-Proto).
app.set('trust proxy', true)

// L'interface (Vercel) peut appeler ce serveur directement depuis une autre adresse (VITE_API_URL).
// L'authentification passe par l'en-tête Authorization, pas par des cookies.
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-upsert')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})
app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

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

// Mode local : les fichiers (vidéos, captures) sont envoyés et servis ici au lieu de Supabase Storage.
if (isLocalMode) {
  app.put('/api/local-files/*path', async (req, res, next) => {
    try {
      const file = localFilePath((req.params as { path: string[] }).path.join('/'))
      await mkdir(dirname(file), { recursive: true })
      await pipeline(req, createWriteStream(file))
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })
  app.use('/api/local-files', express.static(LOCAL_FILES_DIR))
}

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
