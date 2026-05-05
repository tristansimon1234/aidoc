import Anthropic from '@anthropic-ai/sdk'
import { env } from '../config/env.js'

export const STAGEHAND_MODEL = 'anthropic/claude-sonnet-4-20250514'

/** Default model for marketing-video design agents (architect + per-scene
 *  designer + per-scene rescue). Sonnet 4.6 has visibly stronger TSX +
 *  React composition than Gemini Pro, which is the bottleneck on visual
 *  quality for marketing video mocks. Cost is higher per call but
 *  parallel designer calls cap latency at max(scenes) so wall-clock
 *  doesn't change. */
export const SONNET_MODEL = 'claude-sonnet-4-6'

/** Cheap model for structured-output / scripted tasks where the LLM is
 *  filling slots, not composing TSX. ~3× cheaper than Sonnet on input
 *  (1 vs 3 $/M) and on output (5 vs 15 $/M). Used for the marketing
 *  architect (skeleton + refine edit) where the job is short prose +
 *  structured JSON; the designer stays on Sonnet because TSX
 *  composition is where Sonnet's edge actually shows. */
export const HAIKU_MODEL = 'claude-haiku-4-5'

// Anthropic — optional fallback
export const anthropic = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null

export interface SonnetUsage {
  inputTokens: number
  outputTokens: number
  /** Tokens served from cache (paid at ~0.1× input rate). When the
   *  helper caches the system prompt, repeated calls in the same
   *  generation pull most of the prefix from cache. */
  cacheReadInputTokens: number
  /** Tokens written to cache on this call (paid at ~1.25× input rate
   *  for 5-min TTL). High on the first call of a generation, near-zero
   *  on subsequent calls in the same window. */
  cacheCreationInputTokens: number
}

/**
 * Mirror of the gemini.client `generateText` API on Anthropic's Messages
 * endpoint. Used by the marketing-video design agents (architect +
 * per-scene designer + per-scene rescue) so the call sites stay
 * mechanical when switching backends.
 *
 * Two output modes:
 *  - **plain text** (default): returns the assistant's text content as
 *    a string. Use for the designer + repair paths (raw TSX out).
 *  - **structured JSON via tool-use** (`jsonSchema` set): forces the
 *    model to emit a single tool_use block whose `input` matches the
 *    schema. Returns the input JSON-stringified so the rest of the
 *    parsing path (JSON.parse + Zod) stays unchanged. Use for the
 *    architect path.
 *
 * Prompt caching: when `cacheSystem` is true (default when a
 * non-trivial systemPrompt is provided), adds `cache_control:
 * ephemeral` on the system block. With 4 parallel designer calls per
 * video sharing the same designer system prompt, the system tokens
 * land in the cache after the first call and the rest read at ~0.1×.
 *
 * Throws if `ANTHROPIC_API_KEY` is unset — this helper is only used by
 * paths that have already opted into Sonnet, never the default doc /
 * chat / Try Doc flows.
 */
export async function generateSonnetText(opts: {
  userPrompt: string
  systemPrompt?: string
  /** When true (default if systemPrompt is present), cache_control on
   *  the system block. Set false for one-off calls where the cache
   *  write premium isn't worth it. */
  cacheSystem?: boolean
  maxTokens: number
  /** Sampling temperature 0-1. Defaults to 1 (Sonnet's default). Pass
   *  0.5-0.7 for code generation, 0.3-0.5 for structured JSON. */
  temperature?: number
  /** JSON Schema for structured output. When set, the helper defines a
   *  single tool `submit_response` with this schema and forces the
   *  model to call it; returns `JSON.stringify(toolUse.input)` so the
   *  caller's existing JSON.parse + Zod path stays intact. */
  jsonSchema?: Record<string, unknown>
  /** Model override — defaults to claude-sonnet-4-6. */
  model?: string
}): Promise<{ text: string; usage: SonnetUsage }> {
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY is not configured')
  }

  const model = opts.model ?? SONNET_MODEL
  const cacheSystem = opts.cacheSystem ?? !!opts.systemPrompt

  const systemBlocks = opts.systemPrompt
    ? [
        cacheSystem
          ? {
              type: 'text' as const,
              text: opts.systemPrompt,
              cache_control: { type: 'ephemeral' as const },
            }
          : { type: 'text' as const, text: opts.systemPrompt },
      ]
    : undefined

  // Tool-use is Anthropic's canonical structured-output mechanism. Force
  // the model to invoke a single tool whose input_schema matches the
  // caller's expected JSON shape; the model's tool_use.input then IS
  // the structured response.
  const toolsConfig = opts.jsonSchema
    ? {
        tools: [
          {
            name: 'submit_response',
            description:
              'Submit your structured response. The arguments you pass to this tool ARE the response — do not include any prose outside the tool call.',
            input_schema: opts.jsonSchema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: 'tool' as const, name: 'submit_response' },
      }
    : {}

  const response = await anthropic.messages.create({
    model,
    max_tokens: opts.maxTokens,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(systemBlocks ? { system: systemBlocks } : {}),
    ...toolsConfig,
    messages: [{ role: 'user', content: opts.userPrompt }],
  })

  let text = ''
  if (opts.jsonSchema) {
    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )
    if (!toolUse) {
      console.warn(
        `[sonnet] No tool_use block in structured-output response. stop_reason=${response.stop_reason}`,
      )
    } else {
      text = JSON.stringify(toolUse.input)
    }
  } else {
    // Plain text path — concatenate every text block. Sonnet usually
    // returns a single block for code-gen, but join defensively.
    text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
  }

  const usage: SonnetUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
  }

  if (response.stop_reason === 'refusal') {
    console.warn(`[sonnet] Refusal stop_reason on ${model}. Returning empty.`)
    return { text: '', usage }
  }
  if (response.stop_reason === 'max_tokens' && text.length > 0) {
    console.warn(
      `[sonnet] Truncated response from ${model}: stop_reason=max_tokens ` +
        `inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens} ` +
        `(consider raising maxTokens above ${opts.maxTokens})`,
    )
  }

  return { text, usage }
}
