import {
  GoogleGenAI,
  FileState,
  MediaResolution,
  createPartFromUri,
  createUserContent,
} from '@google/genai'
import type { z } from 'zod'
import { env } from '../env.js'

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY })

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

/**
 * Envoie une vidéo locale à Gemini et renvoie une réponse JSON validée par `schema`.
 * En résolution normale une vidéo coûte ~300 tokens/s : au-delà de 40 min on passe
 * en basse résolution pour rester sous la limite de contexte (1M tokens).
 */
export async function askAboutVideo<T>(
  videoFile: string,
  durationSeconds: number,
  prompt: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const mediaResolution =
    durationSeconds > 40 * 60
      ? MediaResolution.MEDIA_RESOLUTION_LOW
      : MediaResolution.MEDIA_RESOLUTION_MEDIUM
  let file = await ai.files.upload({ file: videoFile, config: { mimeType: 'video/mp4' } })
  try {
    while (file.state === FileState.PROCESSING) {
      await new Promise((r) => setTimeout(r, 3000))
      file = await ai.files.get({ name: file.name ?? '' })
    }
    if (file.state === FileState.FAILED || !file.uri) {
      throw new Error("Gemini n'a pas pu lire la vidéo")
    }
    const uri = file.uri
    return await withRetry(async () => {
      const res = await ai.models.generateContent({
        model: env.GEMINI_MODEL,
        contents: createUserContent([createPartFromUri(uri, 'video/mp4'), prompt]),
        config: { responseMimeType: 'application/json', maxOutputTokens: 32000, mediaResolution },
      })
      return parseJson(res.text ?? '', schema)
    })
  } finally {
    if (file.name) await ai.files.delete({ name: file.name }).catch(() => {})
  }
}

export async function askText(prompt: string): Promise<string> {
  return withRetry(async () => {
    const res = await ai.models.generateContent({
      model: env.GEMINI_MODEL,
      contents: prompt,
      config: { maxOutputTokens: 32000 },
    })
    const text = res.text?.trim()
    if (!text) throw new Error('Réponse Gemini vide')
    return text
  })
}

export async function askJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
  return withRetry(async () => {
    const res = await ai.models.generateContent({
      model: env.GEMINI_MODEL,
      contents: prompt,
      config: { responseMimeType: 'application/json', maxOutputTokens: 16000 },
    })
    return parseJson(res.text ?? '', schema)
  })
}

/** Synthèse vocale Gemini → fichier WAV (PCM 16 bits, 24 kHz, mono). */
export async function speakWithGemini(text: string): Promise<Buffer> {
  return withRetry(async () => {
    const res = await ai.models.generateContent({
      model: env.GEMINI_TTS_MODEL,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
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
