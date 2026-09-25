// Claude (Anthropic) : écrit le code des scènes des vidéos marketing. Sans ANTHROPIC_API_KEY,
// c'est Gemini (modèle GEMINI_CODE_MODEL) qui s'en charge, voir codeChat().
import Anthropic from '@anthropic-ai/sdk'
import type { z } from 'zod'
import { env } from '../env.js'
import { askJson, askJsonWithImages, geminiChat, parseJson } from './gemini.js'

/** Un morceau de message : du texte ou une image PNG (rendu d'une scène, capture). */
export type ChatPart = { text: string } | { image: Buffer; mediaType: 'image/png' | 'image/jpeg' }

/** Conversation avec le modèle qui code : l'historique est gardé pour les corrections successives. */
export interface CodeChat {
  send(parts: ChatPart[]): Promise<string>
}

/** Claude si une clé Anthropic est configurée (le meilleur pour coder des interfaces), sinon Gemini. */
export function codeChat(system: string): CodeChat {
  return env.ANTHROPIC_API_KEY ? claudeChat(system, env.ANTHROPIC_API_KEY) : geminiChat(system)
}

export function codeModelName(): string {
  return env.ANTHROPIC_API_KEY ? env.CLAUDE_MODEL : env.GEMINI_CODE_MODEL
}

let client: Anthropic | null = null

/**
 * Textes rédigés (voix off des SOP, storyboard et voix off des vidéos marketing) : Claude si une clé
 * Anthropic est configurée, sinon Gemini. Si Claude échoue (crédits, panne), Gemini prend le relais.
 * Réponse JSON validée par le schéma ; les images (JPEG) sont précédées de leur libellé.
 */
export async function writeJson<T>(
  prompt: string,
  schema: z.ZodType<T>,
  images: { label: string; jpeg: Buffer }[] = [],
): Promise<T> {
  const viaGemini = () =>
    images.length > 0 ? askJsonWithImages(prompt, images, schema) : askJson(prompt, schema)
  if (!env.ANTHROPIC_API_KEY) return viaGemini()
  const parts: ChatPart[] = [
    ...images.flatMap((img): ChatPart[] => [
      { text: img.label },
      { image: img.jpeg, mediaType: 'image/jpeg' },
    ]),
    { text: prompt },
  ]
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const chat = claudeChat(WRITER_SYSTEM, env.ANTHROPIC_API_KEY, 'medium')
      return parseJson(await chat.send(parts), schema)
    } catch (err) {
      console.warn(`[claude] rédaction, essai ${attempt} échoué`, (err as Error).message)
    }
  }
  console.warn('[claude] rédaction confiée à Gemini')
  return viaGemini()
}

const WRITER_SYSTEM =
  'You are an expert scriptwriter for product videos and tutorials. Follow the instructions exactly and answer with the JSON object only: no code fence, no comment before or after.'

function claudeChat(
  system: string,
  apiKey: string,
  effort: 'low' | 'medium' | 'high' = 'high',
): CodeChat {
  client ??= new Anthropic({ apiKey })
  const anthropic = client
  const messages: Anthropic.Beta.BetaMessageParam[] = []
  return {
    async send(parts) {
      messages.push({ role: 'user', content: parts.map(toClaudeBlock) })
      // Relais automatique en cas de refus : proposé pour les modèles Opus 5 / Fable seulement.
      const fallback = /^claude-(opus-5|fable)/.test(env.CLAUDE_MODEL)
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
        : {}
      const stream = anthropic.beta.messages.stream({
        model: env.CLAUDE_MODEL,
        max_tokens: 32000,
        thinking: { type: 'adaptive' },
        output_config: { effort },
        ...fallback,
        // Le long prompt système (la doc de la boîte à outils) est mis en cache : relu à ~10 % du prix
        // par chaque scène et chaque correction.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
      })
      const message = await stream.finalMessage()
      if (message.stop_reason === 'refusal') throw new Error('Claude a refusé la demande')
      messages.push({ role: 'assistant', content: message.content })
      const text = message.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim()
      if (!text) throw new Error(`Réponse Claude vide (${message.stop_reason})`)
      return text
    },
  }
}

function toClaudeBlock(part: ChatPart): Anthropic.Beta.BetaContentBlockParam {
  if ('text' in part) return { type: 'text', text: part.text }
  return {
    type: 'image',
    source: { type: 'base64', media_type: part.mediaType, data: part.image.toString('base64') },
  }
}
