// Service vidéo (Railway) : reçoit les SOPs à traiter depuis l'API (Vercel) et fait tout le travail
// lourd — ffmpeg, Gemini, voix off — puis écrit le résultat dans Supabase.
import express from 'express'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { env } from '../server/env.js'
import { enqueue, recoverInterrupted } from '../server/pipeline/queue.js'

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
