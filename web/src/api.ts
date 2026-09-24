// Tous les appels au serveur.
import { accessToken } from './supabase'

export type Voice = 'none' | 'standard' | 'premium'
export type Status = 'uploading' | 'processing' | 'ready' | 'failed'

export interface Offer {
  id: 'pack' | 'monthly'
  credits: number
  recurring: boolean
  price: string | null
}

export interface Me {
  credits: number
  hasBillingAccount: boolean
  premiumVoice: boolean
  languages: string[]
  minutesPerCredit: number
  maxVideoMinutes: number
  offers: Offer[]
}

export interface Sop {
  id: string
  title: string
  language: string
  voice: Voice
  status: Status
  progress: string | null
  error: string | null
  creditsUsed: number
  durationSeconds: number | null
  markdown: string | null
  videoUrl: string | null
  createdAt: string
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await accessToken()}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(json.error ?? `Error ${res.status}`)
  return json as T
}

export const api = {
  me: () => call<Me>('GET', '/me'),
  listSops: () => call<Sop[]>('GET', '/sops'),
  getSop: (id: string) => call<Sop>('GET', `/sops/${id}`),
  deleteSop: (id: string) => call<{ ok: true }>('DELETE', `/sops/${id}`),
  checkout: (offer: Offer['id']) => call<{ url: string }>('POST', '/checkout', { offer }),
  billingPortal: () => call<{ url: string }>('POST', '/billing-portal'),

  /** Crée la SOP, envoie la vidéo directement au stockage, puis lance le traitement. */
  async createSop(
    input: { title: string; language: string; voice: Voice; file: File; durationSeconds: number },
    onProgress: (percent: number) => void,
  ): Promise<string> {
    const { id, uploadUrl } = await call<{ id: string; uploadUrl: string }>('POST', '/sops', {
      title: input.title,
      language: input.language,
      voice: input.voice,
      fileName: input.file.name,
      durationSeconds: input.durationSeconds,
    })
    await uploadWithProgress(uploadUrl, input.file, onProgress)
    await call('POST', `/sops/${id}/start`, { durationSeconds: input.durationSeconds })
    return id
  },
}

function uploadWithProgress(url: string, file: File, onProgress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    // Fichier brut (accepté par Supabase Storage comme par le mode local).
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('x-upsert', 'true')
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100))
    xhr.onload = () =>
      xhr.status < 300 ? resolve() : reject(new Error(`Video upload rejected (${xhr.status})`))
    xhr.onerror = () => reject(new Error('Video upload interrupted'))
    xhr.send(file)
  })
}

/** Durée d'un fichier vidéo lue par le navigateur (les .webm enregistrés n'en ont parfois pas : on force). */
export function videoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.src = URL.createObjectURL(file)
    video.onerror = () => reject(new Error('Unreadable video file'))
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration)) return done()
      video.currentTime = 1e7
      video.ontimeupdate = () => {
        video.ontimeupdate = null
        done()
      }
    }
    function done() {
      URL.revokeObjectURL(video.src)
      resolve(video.duration)
    }
  })
}
