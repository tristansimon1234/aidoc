import {
  GoogleGenAI,
  type Content,
  FileState,
  MediaResolution,
  createPartFromUri,
  createUserContent,
} from '@google/genai'
import type { z } from 'zod'
import { env } from '../env.js'
import type { CodeChat } from './claude.js'

let client: GoogleGenAI | null = null
function gemini(): GoogleGenAI {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY manquante')
  client ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY })
  return client
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= attempts) throw err
      console.warn(`[gemini] tentative ${i} échouée, nouvel essai…`, (err as Error).message)
      await new Promise((r) => setTimeout(r, 5000 * i))
    }
  }
}

function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '')
  return schema.parse(JSON.parse(cleaned))
}

/** Une vidéo déjà envoyée à Gemini, qu'on peut interroger plusieurs fois (image + son). */
export interface GeminiVideo {
  json<T>(prompt: string, schema: z.ZodType<T>): Promise<T>
  text(prompt: string): Promise<string>
}

/**
 * Envoie une vidéo locale à Gemini une seule fois, la rend interrogeable dans `fn`, puis la supprime.
 * Gemini voit l'image ET entend le son. En résolution normale une vidéo coûte ~300 tokens/s :
 * au-delà de 40 min on passe en basse résolution pour rester sous la limite de contexte (1M tokens).
 */
export async function withVideo<R>(
  videoFile: string,
  durationSeconds: number,
  fn: (video: GeminiVideo) => Promise<R>,
): Promise<R> {
  const mediaResolution =
    durationSeconds > 40 * 60
      ? MediaResolution.MEDIA_RESOLUTION_LOW
      : MediaResolution.MEDIA_RESOLUTION_MEDIUM
  let file = await gemini().files.upload({ file: videoFile, config: { mimeType: 'video/mp4' } })
  try {
    while (file.state === FileState.PROCESSING) {
      await new Promise((r) => setTimeout(r, 3000))
      file = await gemini().files.get({ name: file.name ?? '' })
    }
    if (file.state === FileState.FAILED || !file.uri) {
      throw new Error("Gemini n'a pas pu lire la vidéo")
    }
    const uri = file.uri
    const ask = (prompt: string, json: boolean) =>
      withRetry(async () => {
        const res = await gemini().models.generateContent({
          model: env.GEMINI_MODEL,
          contents: createUserContent([createPartFromUri(uri, 'video/mp4'), prompt]),
          config: {
            ...(json ? { responseMimeType: 'application/json' } : {}),
            maxOutputTokens: 60000,
            mediaResolution,
          },
        })
        const text = res.text?.trim()
        if (!text) throw new Error('Réponse Gemini vide')
        return text
      })
    return await fn({
      json: async (prompt, schema) => parseJson(await ask(prompt, true), schema),
      text: (prompt) => ask(prompt, false),
    })
  } finally {
    if (file.name)
      await gemini()
        .files.delete({ name: file.name })
        .catch(() => {})
  }
}

export async function askJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
  return withRetry(async () => {
    const res = await gemini().models.generateContent({
      model: env.GEMINI_MODEL,
      contents: prompt,
      config: { responseMimeType: 'application/json', maxOutputTokens: 16000 },
    })
    return parseJson(res.text ?? '', schema)
  })
}

/** Question avec des images (JPEG), chacune précédée de son libellé ; réponse JSON validée. */
export async function askJsonWithImages<T>(
  prompt: string,
  images: { label: string; jpeg: Buffer }[],
  schema: z.ZodType<T>,
): Promise<T> {
  const parts = [
    { text: prompt },
    ...images.flatMap((img) => [
      { text: img.label },
      { inlineData: { mimeType: 'image/jpeg', data: img.jpeg.toString('base64') } },
    ]),
  ]
  return withRetry(async () => {
    const res = await gemini().models.generateContent({
      model: env.GEMINI_MODEL,
      contents: [{ role: 'user', parts }],
      config: { responseMimeType: 'application/json', maxOutputTokens: 4000 },
    })
    return parseJson(res.text ?? '', schema)
  })
}

/** Synthèse vocale Gemini → fichier WAV (PCM 16 bits, 24 kHz, mono). */
export async function speakWithGemini(text: string, voiceName = 'Kore'): Promise<Buffer> {
  return withRetry(async () => {
    const res = await gemini().models.generateContent({
      model: env.GEMINI_TTS_MODEL,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      },
    })
    const data = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data
    if (!data) throw new Error('Gemini TTS : aucun audio renvoyé')
    return pcmToWav(Buffer.from(data, 'base64'), 24000)
  })
}

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // taille du bloc fmt
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // octets / seconde
  header.writeUInt16LE(2, 32) // octets / échantillon
  header.writeUInt16LE(16, 34) // bits / échantillon
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Conversation avec Gemini (modèle GEMINI_CODE_MODEL) pour écrire du code, quand Claude n'est pas configuré. */
export function geminiChat(system: string): CodeChat {
  const contents: Content[] = []
  return {
    async send(parts) {
      contents.push({
        role: 'user',
        parts: parts.map((p) =>
          'text' in p
            ? { text: p.text }
            : { inlineData: { mimeType: p.mediaType, data: p.image.toString('base64') } },
        ),
      })
      const text = await withRetry(async () => {
        const res = await gemini().models.generateContent({
          model: env.GEMINI_CODE_MODEL,
          contents,
          config: { systemInstruction: system, maxOutputTokens: 32000 },
        })
        const out = res.text?.trim()
        if (!out) throw new Error('Réponse Gemini vide')
        return out
      })
      contents.push({ role: 'model', parts: [{ text }] })
      return text
    },
  }
}
