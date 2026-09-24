import { env } from '../env.js'

export function isElevenLabsEnabled(): boolean {
  return Boolean(env.ELEVENLABS_API_KEY)
}

/** Voix « Premium » → MP3. */
export async function speakWithElevenLabs(text: string): Promise<Buffer> {
  if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY manquante')
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
    },
  )
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return Buffer.from(await res.arrayBuffer())
}
