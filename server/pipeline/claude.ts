// Claude (Anthropic) : écrit le code des scènes des vidéos marketing. Sans ANTHROPIC_API_KEY,
// c'est Gemini (modèle GEMINI_CODE_MODEL) qui s'en charge, voir codeChat().
import Anthropic from '@anthropic-ai/sdk'
import { env } from '../env.js'
import { geminiChat } from './gemini.js'

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

function claudeChat(system: string, apiKey: string): CodeChat {
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
        output_config: { effort: 'high' },
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
