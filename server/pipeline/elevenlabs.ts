import { z } from 'zod'
import { env } from '../env.js'

export function isElevenLabsEnabled(): boolean {
  return Boolean(env.ELEVENLABS_API_KEY)
}

/**
 * Voix premium ElevenLabs → MP3. Modèle ELEVENLABS_MODEL par défaut (Flash : 2 fois moins cher) ; un
 * autre modèle peut être demandé (v3 pour le marketing) : s'il refuse, on revient au modèle par défaut.
 */
export async function speakWithElevenLabs(
  text: string,
  voiceId: string,
  model = env.ELEVENLABS_MODEL,
): Promise<Buffer> {
  if (model !== env.ELEVENLABS_MODEL) {
    try {
      return await elevenLabsTts(text, voiceId, model)
    } catch (err) {
      console.warn(
        `[elevenlabs] ${model} impossible, ${env.ELEVENLABS_MODEL} à la place`,
        (err as Error).message,
      )
    }
  }
  return elevenLabsTts(text, voiceId, env.ELEVENLABS_MODEL)
}

async function elevenLabsTts(text: string, voiceId: string, model: string): Promise<Buffer> {
  if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY manquante')
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: model }),
    },
  )
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return Buffer.from(await res.arrayBuffer())
}

const VoicesSchema = z.object({
  voices: z.array(
    z.object({
      voice_id: z.string(),
      name: z.string(),
      category: z.string().nullish(),
      labels: z.record(z.string(), z.string()).nullish(),
    }),
  ),
})

export interface ElevenLabsVoice {
  id: string
  name: string
  description: string
  cloned: boolean
}

/** Voix du compte ElevenLabs (voix prêtes à l'emploi + voix clonées), en cache 10 min. */
let cache: { at: number; voices: ElevenLabsVoice[] } | null = null
export async function listElevenLabsVoices(): Promise<ElevenLabsVoice[]> {
  if (!env.ELEVENLABS_API_KEY) return []
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.voices
  const key = env.ELEVENLABS_API_KEY
  const get = (url: string) => fetch(url, { headers: { 'xi-api-key': key } })
  // /v1/voices d'abord ; si ElevenLabs le refuse, la version paginée /v2/voices.
  let res = await get('https://api.elevenlabs.io/v1/voices')
  if (!res.ok) {
    console.warn(
      `[voices] ElevenLabs /v1/voices ${res.status}: ${(await res.text()).slice(0, 300)}`,
    )
    res = await get('https://api.elevenlabs.io/v2/voices?page_size=100')
  }
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const { voices } = VoicesSchema.parse(await res.json())
  const list = voices.map((v) => {
    const cloned = v.category === 'cloned' || v.category === 'professional'
    const labels = v.labels ?? {}
    const description = cloned
      ? 'Your cloned voice'
      : [labels.gender, labels.accent, labels.description ?? labels.use_case]
          .filter(Boolean)
          .join(' · ')
    return { id: v.voice_id, name: v.name, description, cloned }
  })
  // Voix clonées en premier : c'est sans doute la voix de l'utilisateur.
  list.sort((a, b) => Number(b.cloned) - Number(a.cloned) || a.name.localeCompare(b.name))
  cache = { at: Date.now(), voices: list }
  return list
}

/** Musique de fond composée par ElevenLabs (MP3). Compter 30 à 60 s de génération. */
export async function generateMusic(prompt: string, durationMs: number): Promise<Buffer> {
  if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY manquante')
  const res = await fetch('https://api.elevenlabs.io/v1/music/compose', {
    method: 'POST',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({ prompt, music_length_ms: Math.round(durationMs) }),
  })
  if (!res.ok)
    throw new Error(`ElevenLabs Music ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return Buffer.from(await res.arrayBuffer())
}
