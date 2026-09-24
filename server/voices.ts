// Voix proposées pour la voix off : une sélection de voix Gemini (incluses) et, si configuré,
// toutes les voix du compte ElevenLabs (premium, dont les voix clonées).
// Identifiant stocké sur la SOP : "none", "gemini:<nom>" ou "elevenlabs:<id>".
import { env } from './env.js'
import { speakWithGemini } from './pipeline/gemini.js'
import { listElevenLabsVoices, speakWithElevenLabs } from './pipeline/elevenlabs.js'
import { TONES, type Tone } from './pipeline/prompts.js'

export interface VoiceOption {
  id: string
  name: string
  description: string
  premium: boolean
}

/** Les 30 voix de Gemini TTS, avec le style décrit par Google (genre indiqué quand il est connu). */
const GEMINI_VOICES: VoiceOption[] = [
  { id: 'gemini:Kore', name: 'Kore', description: 'Female · firm', premium: false },
  { id: 'gemini:Aoede', name: 'Aoede', description: 'Female · breezy', premium: false },
  { id: 'gemini:Zephyr', name: 'Zephyr', description: 'Female · bright', premium: false },
  { id: 'gemini:Leda', name: 'Leda', description: 'Female · youthful', premium: false },
  { id: 'gemini:Charon', name: 'Charon', description: 'Male · informative', premium: false },
  { id: 'gemini:Orus', name: 'Orus', description: 'Male · firm', premium: false },
  { id: 'gemini:Puck', name: 'Puck', description: 'Male · upbeat', premium: false },
  { id: 'gemini:Fenrir', name: 'Fenrir', description: 'Male · excitable', premium: false },
  { id: 'gemini:Achird', name: 'Achird', description: 'Friendly', premium: false },
  { id: 'gemini:Sulafat', name: 'Sulafat', description: 'Warm', premium: false },
  { id: 'gemini:Vindemiatrix', name: 'Vindemiatrix', description: 'Gentle', premium: false },
  { id: 'gemini:Achernar', name: 'Achernar', description: 'Soft', premium: false },
  { id: 'gemini:Callirrhoe', name: 'Callirrhoe', description: 'Easy-going', premium: false },
  { id: 'gemini:Umbriel', name: 'Umbriel', description: 'Easy-going', premium: false },
  { id: 'gemini:Zubenelgenubi', name: 'Zubenelgenubi', description: 'Casual', premium: false },
  { id: 'gemini:Iapetus', name: 'Iapetus', description: 'Clear', premium: false },
  { id: 'gemini:Erinome', name: 'Erinome', description: 'Clear', premium: false },
  { id: 'gemini:Rasalgethi', name: 'Rasalgethi', description: 'Informative', premium: false },
  { id: 'gemini:Sadaltager', name: 'Sadaltager', description: 'Knowledgeable', premium: false },
  { id: 'gemini:Schedar', name: 'Schedar', description: 'Even', premium: false },
  { id: 'gemini:Alnilam', name: 'Alnilam', description: 'Firm', premium: false },
  { id: 'gemini:Gacrux', name: 'Gacrux', description: 'Mature', premium: false },
  { id: 'gemini:Algieba', name: 'Algieba', description: 'Smooth', premium: false },
  { id: 'gemini:Despina', name: 'Despina', description: 'Smooth', premium: false },
  { id: 'gemini:Autonoe', name: 'Autonoe', description: 'Bright', premium: false },
  { id: 'gemini:Laomedeia', name: 'Laomedeia', description: 'Upbeat', premium: false },
  { id: 'gemini:Sadachbia', name: 'Sadachbia', description: 'Lively', premium: false },
  { id: 'gemini:Pulcherrima', name: 'Pulcherrima', description: 'Forward', premium: false },
  { id: 'gemini:Enceladus', name: 'Enceladus', description: 'Breathy', premium: false },
  { id: 'gemini:Algenib', name: 'Algenib', description: 'Gravelly', premium: false },
]

export const DEFAULT_VOICE = 'gemini:Kore'

export async function listVoices(): Promise<VoiceOption[]> {
  const premium = await listElevenLabsVoices().catch((err: Error) => {
    console.warn('[voices] ElevenLabs indisponible', err.message)
    return []
  })
  return [
    ...GEMINI_VOICES,
    ...premium.map((v) => ({
      id: `elevenlabs:${v.id}`,
      name: v.name,
      description: v.description,
      premium: true,
    })),
  ]
}

export async function isKnownVoice(id: string): Promise<boolean> {
  return id === 'none' || (await listVoices()).some((v) => v.id === id)
}

/**
 * Synthèse d'une phrase avec la voix choisie. Renvoie l'audio et son extension.
 * Les anciennes valeurs « standard » / « premium » restent comprises.
 */
export async function speak(
  voice: string,
  text: string,
  tone: Tone,
): Promise<{ audio: Buffer; ext: 'wav' | 'mp3' }> {
  if (voice === 'premium') voice = `elevenlabs:${env.ELEVENLABS_VOICE_ID}`
  if (voice === 'standard' || !voice.includes(':')) voice = DEFAULT_VOICE
  const [provider, id = ''] = voice.split(/:(.*)/s)
  if (provider === 'elevenlabs') return { audio: await speakWithElevenLabs(text, id), ext: 'mp3' }
  // Gemini suit une consigne d'intonation placée avant le texte (elle n'est pas lue à voix haute).
  return { audio: await speakWithGemini(`${TONES[tone].speech}: ${text}`, id), ext: 'wav' }
}

const SAMPLE: Record<string, string> = {
  fr: 'Bonjour ! Je vais vous guider pas à pas dans cette procédure.',
  en: "Hi! I'll guide you through this procedure, step by step.",
  es: '¡Hola! Te guiaré paso a paso en este procedimiento.',
  de: 'Hallo! Ich führe Sie Schritt für Schritt durch dieses Verfahren.',
  it: 'Ciao! Ti guiderò passo dopo passo in questa procedura.',
  pt: 'Olá! Vou guiá-lo passo a passo neste procedimento.',
  nl: 'Hallo! Ik begeleid je stap voor stap door deze procedure.',
}

/** Extrait d'écoute d'une voix dans la langue choisie, gardé en mémoire (une synthèse par voix et langue). */
const previews = new Map<string, Promise<{ audio: Buffer; ext: 'wav' | 'mp3' }>>()
export function previewVoice(voice: string, language: string, tone: Tone) {
  const key = `${voice}|${language}|${tone}`
  let preview = previews.get(key)
  if (!preview) {
    preview = speak(voice, SAMPLE[language] ?? SAMPLE.en!, tone)
    preview.catch(() => previews.delete(key))
    previews.set(key, preview)
  }
  return preview
}
