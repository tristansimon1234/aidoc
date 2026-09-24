// Confie une SOP au service vidéo (Railway). En local, sans VIDEO_SERVICE_URL, on traite sur place.
import { env } from './env.js'

export async function dispatchSop(sopId: string): Promise<void> {
  if (!env.VIDEO_SERVICE_URL) {
    const { enqueue } = await import('./pipeline/queue.js')
    enqueue(sopId)
    return
  }
  const res = await fetch(`${env.VIDEO_SERVICE_URL.replace(/\/$/, '')}/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-video-service-secret': env.VIDEO_SERVICE_SECRET ?? '',
    },
    body: JSON.stringify({ sopId }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Service vidéo : HTTP ${res.status}`)
}
