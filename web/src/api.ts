// Tous les appels au serveur.
import { accessToken, apiUrl } from './supabase'

/** « none », « gemini:<nom> » ou « elevenlabs:<id> ». */
export type Voice = string

export interface VoiceOption {
  id: string
  name: string
  description: string
  premium: boolean
}
/** SOP (procédure + vidéo commentée) ou vidéo marketing courte. */
export type Kind = 'sop' | 'marketing'

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
  tones: { id: string; label: string }[]
  musicAvailable: boolean
  languages: string[]
  minutesPerCredit: number
  marketingCredits: number
  maxVideoMinutes: number
  maxScreenshots: number
  offers: Offer[]
}

export interface Sop {
  id: string
  title: string
  language: string
  voice: Voice
  tone: string
  status: Status
  progress: string | null
  error: string | null
  creditsUsed: number
  durationSeconds: number | null
  markdown: string | null
  videoUrl: string | null
  kind: Kind
  brief: string | null
  targetSeconds: number
  music: boolean
  createdAt: string
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiUrl}/api${path}`, {
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
  /** Voix proposées ; `premiumError` = pourquoi ElevenLabs n'a pas donné ses voix (clé configurée). */
  async voices(): Promise<{ voices: VoiceOption[]; premiumError: string | null }> {
    const res = await call<VoiceOption[] | { voices: VoiceOption[]; premiumError: string | null }>(
      'GET',
      '/voices',
    )
    // Ancien serveur : une simple liste.
    return Array.isArray(res) ? { voices: res, premiumError: null } : res
  },

  /** Extrait audio d'une voix (avec le ton et la langue choisis), prêt à jouer. */
  async voicePreview(voice: Voice, language: string, tone: string): Promise<string> {
    const params = new URLSearchParams({ voice, language, tone })
    const res = await fetch(`${apiUrl}/api/voices/preview?${params}`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
    })
    if (!res.ok) throw new Error('Preview unavailable')
    return URL.createObjectURL(await res.blob())
  },
  checkout: (offer: Offer['id']) => call<{ url: string }>('POST', '/checkout', { offer }),
  billingPortal: () => call<{ url: string }>('POST', '/billing-portal'),

  /**
   * Crée la SOP ou la vidéo marketing, envoie les fichiers directement au stockage (la vidéo, ou les
   * captures converties en JPEG), puis lance le traitement.
   */
  async createSop(
    input: {
      title: string
      language: string
      voice: Voice
      tone: string
      kind: Kind
      brief: string
      targetSeconds: 30 | 60
      music: boolean
      /** SOP : la vidéo et sa durée. Vidéo marketing : les captures. */
      video?: { file: File; durationSeconds: number }
      screenshots?: File[]
    },
    onProgress: (percent: number) => void,
  ): Promise<string> {
    const files: Blob[] = input.video
      ? [input.video.file]
      : await Promise.all((input.screenshots ?? []).map(toJpeg))
    const { id, uploadUrls } = await call<{ id: string; uploadUrls: string[] }>('POST', '/sops', {
      title: input.title,
      language: input.language,
      voice: input.voice,
      tone: input.tone,
      kind: input.kind,
      brief: input.brief,
      targetSeconds: input.targetSeconds,
      music: input.music,
      fileName: input.video?.file.name,
      durationSeconds: input.video?.durationSeconds ?? 0,
      imageCount: input.video ? undefined : files.length,
    })
    const total = files.reduce((sum, f) => sum + f.size, 0) || 1
    let sent = 0
    for (const [i, file] of files.entries()) {
      const uploadUrl = uploadUrls[i]
      if (!uploadUrl) throw new Error('Upload not ready, please try again')
      // En mode local, l'URL d'envoi est relative au serveur de l'API.
      const url = uploadUrl.startsWith('/') ? `${apiUrl}${uploadUrl}` : uploadUrl
      await uploadWithProgress(url, file, (percent) =>
        onProgress(Math.round(((sent + (file.size * percent) / 100) / total) * 100)),
      )
      sent += file.size
    }
    await call('POST', `/sops/${id}/start`, {
      durationSeconds: input.video?.durationSeconds ?? 0,
    })
    return id
  },
}

function uploadWithProgress(url: string, file: Blob, onProgress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    // Fichier brut (accepté par Supabase Storage comme par le mode local).
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('x-upsert', 'true')
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100))
    xhr.onload = () =>
      xhr.status < 300 ? resolve() : reject(new Error(`Upload rejected (${xhr.status})`))
    xhr.onerror = () => reject(new Error('Upload interrupted'))
    xhr.send(file)
  })
}

/**
 * Télécharge un fichier sous le nom voulu. Un simple lien « download » ne marche pas quand le fichier
 * est sur une autre adresse que le site (stockage, service vidéo) : le navigateur l'ouvrirait dans un
 * onglet. On récupère donc le fichier, puis on l'enregistre.
 */
export async function downloadFile(url: string, fileName: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const href = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = href
  a.download = fileName.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'video.mp4'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
}

/** Capture (PNG, JPEG, WebP…) → JPEG de 1920 px de large au plus, pour un envoi léger et un seul format. */
export async function toJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`Unreadable image: ${file.name}`)
  })
  const scale = Math.min(1, 1920 / bitmap.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`Unreadable image: ${file.name}`))),
      'image/jpeg',
      0.9,
    ),
  )
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
