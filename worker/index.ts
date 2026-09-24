// Service vidéo (Railway) : reçoit les SOPs à traiter depuis l'API (Vercel) et fait tout le travail
// lourd — ffmpeg, Gemini, voix off — puis écrit le résultat dans Supabase.
//
// Sans Supabase (mode test), ce service fait tout : il sert aussi l'API (server/index.ts), stocke
// les données sur son disque, et l'interface Vercel l'appelle directement (VITE_API_URL).
import express from 'express'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { env } from '../server/env.js'
import { enqueue, recoverInterrupted } from '../server/pipeline/queue.js'
import { isLocalMode } from '../server/db.js'

if (isLocalMode) {
  await import('../server/index.js')
} else {
  startVideoService()
}

function startVideoService(): void {
  if (!env.VIDEO_SERVICE_SECRET) throw new Error('VIDEO_SERVICE_SECRET manquant')
  const secret = Buffer.from(env.VIDEO_SERVICE_SECRET)

  function authorized(header: string | undefined): boolean {
    const given = Buffer.from(header ?? '')
    return given.length === secret.length && timingSafeEqual(given, secret)
  }

  const app = express()
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.post('/process', (req, res) => {
    if (!authorized(req.header('x-video-service-secret'))) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const parsed = z.object({ sopId: z.string().uuid() }).safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' })
      return
    }
    enqueue(parsed.data.sopId)
    res.status(202).json({ queued: true })
  })

  app.listen(env.PORT, () => {
    console.log(`Service vidéo → port ${env.PORT}`)
    recoverInterrupted().catch((err) => console.error('[pipeline] reprise impossible', err))
  })
}
