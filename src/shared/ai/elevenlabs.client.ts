import { env } from '../config/env.js'

const BASE_URL = 'https://api.elevenlabs.io/v1'
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL' // "Sarah" — clear, professional
const DEFAULT_MODEL_ID = 'eleven_v3'

function getApiKey(): string {
  if (!env.ELEVENLABS_API_KEY) {
    console.error('[elevenlabs] ELEVENLABS_API_KEY is not set. Available env keys:', Object.keys(env).join(', '))
    throw new Error('ELEVENLABS_API_KEY is not configured. Add it to your Vercel environment variables and redeploy.')
  }
  return env.ELEVENLABS_API_KEY
}

export interface Voice {
  voiceId: string
  name: string
  category: string
  labels: Record<string, string>
}

export interface SpeechOptions {
  voiceId?: string
  modelId?: string
  /** Lower = more expressive/varied intonation. Higher = monotone. Default: 0.3 */
  stability?: number
  /** Voice consistency. Default: 0.75 */
  similarityBoost?: number
  /** Expressiveness/style exaggeration (0-1). Default: 0.6 */
  style?: number
  /** Boost clarity and presence. Default: true */
  speakerBoost?: boolean
}

/**
 * Synthesize speech from text using ElevenLabs TTS API.
 * Returns an audio buffer (mp3).
 */
export async function synthesizeSpeech(
  text: string,
  options?: SpeechOptions,
): Promise<Buffer> {
  const apiKey = getApiKey()
  const voiceId = options?.voiceId ?? DEFAULT_VOICE_ID
  const modelId = options?.modelId ?? DEFAULT_MODEL_ID

  console.log(`[elevenlabs] Synthesizing: voice=${voiceId}, model=${modelId}, text=${text.length} chars, stability=${options?.stability ?? 0.5}, style=${options?.style ?? 0.5}`)

  const response = await fetch(`${BASE_URL}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      // Disable text normalization so [audio tags] are not stripped or modified
      apply_text_normalization: 'off',
      voice_settings: {
        stability: options?.stability ?? 0.5,         // lower = more expressive (v3 handles this well)
        similarity_boost: options?.similarityBoost ?? 0.75,
        style: options?.style ?? 0.5,                 // higher = more stylistic variation
        use_speaker_boost: options?.speakerBoost ?? true,
      },
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error')
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${errorBody}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/**
 * Generate background music via ElevenLabs Music API.
 *
 * Returns an MP3 buffer. Latency is significant (30–60s for a 45s track)
 * because the model composes from scratch — show a long-form spinner in
 * the UI when calling. Cost is roughly €0.05–0.10 per 45s track depending
 * on the account plan; not all plans expose the Music API.
 *
 * The prompt is free-form: "upbeat electronic marketing music with driving
 * rhythm" / "calm ambient piano background" / etc. Keep it short and
 * descriptive — long prompts don't produce richer music, just confused
 * output.
 */
export async function generateMusic(
  prompt: string,
  options?: { durationMs?: number },
): Promise<Buffer> {
  const apiKey = getApiKey()
  const durationMs = options?.durationMs ?? 45_000

  console.log(`[elevenlabs] Generating music: durationMs=${durationMs}, prompt="${prompt.slice(0, 100)}"`)

  const response = await fetch(`${BASE_URL}/music/compose`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      prompt,
      music_length_ms: durationMs,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error')
    throw new Error(`ElevenLabs Music failed (${response.status}): ${errorBody}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/**
 * Get available voices from ElevenLabs. Cached in-process for 30min —
 * the voices catalog only changes when the account adds / removes a voice
 * (rare), and the ElevenLabs API itself often takes 1-3s to respond. The
 * cache pays back the cost on every Marketing panel mount that lands on
 * a warm Vercel function.
 */
const VOICES_CACHE_TTL_MS = 30 * 60 * 1000
let _voicesCache: { voices: Voice[]; expiresAt: number } | null = null

export async function getAvailableVoices(): Promise<Voice[]> {
  if (_voicesCache && _voicesCache.expiresAt > Date.now()) return _voicesCache.voices
  const apiKey = getApiKey()

  const response = await fetch(`${BASE_URL}/voices`, {
    headers: { 'xi-api-key': apiKey },
  })

  if (!response.ok) {
    throw new Error(`ElevenLabs voices fetch failed (${response.status})`)
  }

  const data = (await response.json()) as { voices: Array<{ voice_id: string; name: string; category: string; labels: Record<string, string> }> }
  const voices = data.voices.map((v) => ({
    voiceId: v.voice_id,
    name: v.name,
    category: v.category,
    labels: v.labels,
  }))
  _voicesCache = { voices, expiresAt: Date.now() + VOICES_CACHE_TTL_MS }
  return voices
}

/**
 * Check if ElevenLabs is configured and available.
 */
export function isElevenLabsConfigured(): boolean {
  return Boolean(env.ELEVENLABS_API_KEY)
}
