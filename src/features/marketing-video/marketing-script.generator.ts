import { SchemaType, type ResponseSchema } from '@google/generative-ai'
import { generateText } from '../../shared/ai/gemini.client.js'
import { MarketingScriptSchema } from './marketing-video.schema.js'
import type { MarketingScript } from './marketing-video.types.js'

/**
 * Native Gemini schema mirroring MarketingScriptSchema. Passed as
 * `responseSchema` so the API server-side-constrains the output to this exact
 * shape — no missing fields, no rename drift, no envelope wrappers. We still
 * Zod-validate after parsing as defence in depth (string min-length, etc.,
 * which Gemini's schema can't express).
 */
const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    hook: {
      type: SchemaType.OBJECT,
      properties: {
        voiceover: { type: SchemaType.STRING },
        headline: { type: SchemaType.STRING },
        durationSeconds: { type: SchemaType.NUMBER },
      },
      required: ['voiceover', 'headline', 'durationSeconds'],
    },
    scenes: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          voiceover: { type: SchemaType.STRING },
          headline: { type: SchemaType.STRING },
          subhead: { type: SchemaType.STRING },
          screenshotIndex: { type: SchemaType.INTEGER, nullable: true },
          durationSeconds: { type: SchemaType.NUMBER },
        },
        required: ['voiceover', 'headline', 'screenshotIndex', 'durationSeconds'],
      },
    },
    cta: {
      type: SchemaType.OBJECT,
      properties: {
        voiceover: { type: SchemaType.STRING },
        headline: { type: SchemaType.STRING },
        buttonLabel: { type: SchemaType.STRING },
        durationSeconds: { type: SchemaType.NUMBER },
      },
      required: ['voiceover', 'headline', 'buttonLabel', 'durationSeconds'],
    },
    totalDurationSeconds: { type: SchemaType.NUMBER },
    language: { type: SchemaType.STRING },
  },
  required: ['hook', 'scenes', 'cta', 'totalDurationSeconds', 'language'],
}

interface GenerateMarketingScriptInput {
  productName: string
  pageTitle: string
  pageMarkdown: string
  /** Number of doc screenshots available — Gemini may reference up to this
   *  many via `screenshotIndex`. */
  availableScreenshots: number
  /** Captions for each screenshot, so Gemini knows what's on each frame
   *  before deciding which one to feature in which scene. */
  screenshotCaptions: string[]
  /** Target language inferred from the doc — Gemini stays in this language
   *  even if the surrounding UI / metadata uses something else. */
  language: string
  /** Optional creative brief from the user: angle, audience, feature to
   *  emphasize, tone shift. NOT a content source — the doc remains the
   *  factual ground truth, this just steers framing. Trimmed and clamped
   *  upstream by Zod. */
  userPrompt?: string
}

/**
 * Asks Gemini for a 60s marketing-video script grounded in the doc's actual
 * content. Output is structured JSON validated by Zod — never trust raw
 * model output.
 *
 * Why a different prompt than the doc voice-over: the tutorial narration is
 * paced to walk a user through steps. Marketing narration has to hook in 3
 * seconds, sell 3 benefits, and CTA — completely different rhythm. Reusing
 * the tutorial voice-over for marketing produces sleepy videos.
 */
export async function generateMarketingScript(
  input: GenerateMarketingScriptInput,
): Promise<MarketingScript> {
  const captionList = input.screenshotCaptions
    .map((c, i) => `  [${i}] ${c}`)
    .join('\n')

  const briefBlock = input.userPrompt?.trim()
    ? `\n## Creative brief from the user (HIGHEST PRIORITY for framing — but never overrides the documentation as factual ground truth)\n\n${input.userPrompt.trim()}\n\nRespect this brief: pick the angle, audience, tone shift, and which capabilities to emphasize from it. If the brief asks for something the documentation doesn't support, stay grounded in the docs and pivot the framing — don't invent features to satisfy the brief.\n`
    : ''

  const userPrompt = `You are writing a 60-second marketing video script for a SaaS product feature.

The video has THREE acts:
- HOOK (5-8s): one strong opening line that makes the viewer pause their scroll. Specific to the product, not generic ("save time" / "be productive" → no).
- SCENES (3-5 scenes, 8-12s each): each scene shows ONE benefit / capability backed by a doc screenshot. The narrator says it; the headline reinforces it visually.
- CTA (5-7s): clear call-to-action with a short button label.

Total duration MUST be 55-65 seconds. Keep voice-over CONCISE — at ~2.3 words/second, 60s ≈ 140 words total across all parts.

## Source documentation

Product: ${input.productName}
Feature page: ${input.pageTitle}

Markdown content (use as the ONLY source of truth — don't invent features):
${input.pageMarkdown.slice(0, 6000)}
${briefBlock}

## Available screenshots (from the same doc)

${captionList || '(no screenshots available — every scene MUST have screenshotIndex: null)'}

You may set "screenshotIndex" to any integer between 0 and ${Math.max(0, input.availableScreenshots - 1)}, OR to null if a scene works better headline-only (e.g. the hook). Reuse a screenshot if the same view illustrates two benefits.

## Language

Write the entire script in **${input.language}**. Do not switch languages mid-script. UI labels in another language stay verbatim in quotes.

## Tone

Confident, specific, benefit-driven. No buzzwords ("revolutionary", "next-gen", "game-changer" → all banned). No questions to the viewer. Active voice. Concrete verbs.

## Output

Return ONLY valid JSON matching this exact shape, no markdown fences, no preamble:

{
  "hook": {
    "voiceover": "Short opening narration line.",
    "headline": "Big on-screen headline 3-7 words",
    "durationSeconds": 6
  },
  "scenes": [
    {
      "voiceover": "Narration for scene 1 — concrete benefit.",
      "headline": "On-screen headline scene 1",
      "subhead": "Optional supporting line under headline",
      "screenshotIndex": 0,
      "durationSeconds": 10
    }
  ],
  "cta": {
    "voiceover": "Closing narration with the call to action.",
    "headline": "Final on-screen headline",
    "buttonLabel": "Try ${input.productName} free",
    "durationSeconds": 6
  },
  "totalDurationSeconds": 60,
  "language": "${input.language}"
}

Final check before returning: hook.durationSeconds + sum(scenes[].durationSeconds) + cta.durationSeconds MUST equal totalDurationSeconds. Word counts MUST be realistic at 2.3 words/second.`

  const result = await generateText({
    userPrompt,
    // Bumped from 2048: a 5-scene script with brief subheads in a verbose
    // language (FR/DE) was occasionally truncating mid-JSON.
    maxTokens: 4096,
    temperature: 0.6,
    json: true,
    responseSchema: RESPONSE_SCHEMA,
  })

  // Defensive parse — even with responseMimeType: application/json, Gemini
  // occasionally returns markdown fences, leading prose, or trailing
  // commas. Mirror what analyzeVideoWithGemini does in gemini.client.ts so
  // a stray formatting quirk doesn't fail the whole pipeline.
  let jsonStr = result.text.trim()

  // Strip markdown fences (```json ... ``` or ``` ... ```)
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) jsonStr = fenceMatch[1]!

  // Slice to the first { and last } in case Gemini prefixed prose
  const firstBrace = jsonStr.indexOf('{')
  const lastBrace = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }

  // Common Gemini quirks: smart quotes inside strings, trailing commas
  // before } or ]. Both produce SyntaxError at parse time.
  jsonStr = jsonStr
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,(\s*[}\]])/g, '$1')

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(jsonStr)
  } catch (err) {
    // Last-ditch repair — close any unbalanced brackets/braces. Gemini
    // occasionally truncates mid-output or emits unescaped chars.
    // With `responseSchema` set the API normally guarantees valid JSON,
    // but defence in depth.
    let repaired = jsonStr.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, '')
    const openBraces = (repaired.match(/\{/g) ?? []).length
    const closeBraces = (repaired.match(/\}/g) ?? []).length
    const openBrackets = (repaired.match(/\[/g) ?? []).length
    const closeBrackets = (repaired.match(/\]/g) ?? []).length
    repaired += ']'.repeat(Math.max(0, openBrackets - closeBrackets))
    repaired += '}'.repeat(Math.max(0, openBraces - closeBraces))
    try {
      parsedJson = JSON.parse(repaired)
      console.warn('[marketing-script] JSON repaired after parse error:', (err as Error).message)
    } catch {
      console.error('[marketing-script] JSON parse failed. First 500 chars:', jsonStr.slice(0, 500))
      throw new Error(`Marketing script JSON parse failed: ${(err as Error).message}`)
    }
  }

  // Sanity-check the parsed shape BEFORE feeding to Zod. The repair logic
  // above can produce a syntactically valid object that's structurally
  // empty (e.g. when truncation chops off everything past the first key).
  // Without this guard, Zod just reports "expected X, received undefined"
  // for every field, which obscures the actual failure mode (model emitted
  // garbage). Surfaces the raw output so the underlying cause is visible
  // in logs.
  const REQUIRED_TOP_LEVEL = ['hook', 'scenes', 'cta', 'totalDurationSeconds'] as const
  const obj = (parsedJson as Record<string, unknown> | null) ?? {}
  const missingTop = REQUIRED_TOP_LEVEL.filter((k) => !(k in obj))
  if (missingTop.length === REQUIRED_TOP_LEVEL.length) {
    console.error('[marketing-script] Model returned no usable structure. Raw text (first 800 chars):', result.text.slice(0, 800))
    throw new Error(
      'Marketing script generation produced no usable JSON structure (every top-level field missing). ' +
        'This usually means Gemini truncated or emitted malformed output. Please retry.',
    )
  }
  if (missingTop.length > 0) {
    console.error('[marketing-script] Missing top-level fields after parse:', missingTop)
    console.error('[marketing-script] Raw text (first 800 chars):', result.text.slice(0, 800))
  }

  const parsed = MarketingScriptSchema.safeParse(parsedJson)
  if (!parsed.success) {
    // Log the actual JSON Gemini returned so we can see *why* the shape
    // drifted (envelope key, renamed field, etc.) — flatten() alone reports
    // "expected X, received undefined" which doesn't say what we got.
    const preview = JSON.stringify(parsedJson).slice(0, 1000)
    console.error('[marketing-script] Gemini returned (first 1000 chars):', preview)
    console.error('[marketing-script] Zod issues:', JSON.stringify(parsed.error.issues))
    throw new Error(
      `Marketing script JSON failed validation: ${JSON.stringify(parsed.error.issues)}`,
    )
  }

  // Clamp screenshotIndex into a valid range — Gemini sometimes references
  // an index that doesn't exist.
  const max = input.availableScreenshots - 1
  const validated = parsed.data as MarketingScript
  const clamped: MarketingScript = {
    ...validated,
    scenes: validated.scenes.map((s) => ({
      ...s,
      screenshotIndex:
        s.screenshotIndex == null
          ? null
          : Math.max(0, Math.min(max, s.screenshotIndex)),
    })),
  }

  return clamped
}
