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

  console.log(`[elevenlabs] Synthesizing: voice=${voiceId}, model=${modelId}, text=${text.length} chars, stability=${options?.stability ?? 0.65}, style=${options?.style ?? 0.3}`)

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
      voice_settings: {
        stability: options?.stability ?? 0.65,
        similarity_boost: options?.similarityBoost ?? 0.8,
        style: options?.style ?? 0.3,
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
 * Get available voices from ElevenLabs.
 */
export async function getAvailableVoices(): Promise<Voice[]> {
  const apiKey = getApiKey()

  const response = await fetch(`${BASE_URL}/voices`, {
    headers: { 'xi-api-key': apiKey },
  })

  if (!response.ok) {
    throw new Error(`ElevenLabs voices fetch failed (${response.status})`)
  }

  const data = (await response.json()) as { voices: Array<{ voice_id: string; name: string; category: string; labels: Record<string, string> }> }
  return data.voices.map((v) => ({
    voiceId: v.voice_id,
    name: v.name,
    category: v.category,
    labels: v.labels,
  }))
}

/**
 * Check if ElevenLabs is configured and available.
 */
export function isElevenLabsConfigured(): boolean {
  return Boolean(env.ELEVENLABS_API_KEY)
}
