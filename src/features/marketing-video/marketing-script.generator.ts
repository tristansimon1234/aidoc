import { generateText } from '../../shared/ai/gemini.client.js'
import { MarketingScriptSchema } from './marketing-video.schema.js'
import type { MarketingScript } from './marketing-video.types.js'

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
    maxTokens: 2048,
    temperature: 0.6,
    json: true,
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
    // sometimes truncates mid-output when it hits the token cap.
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

  const parsed = MarketingScriptSchema.safeParse(parsedJson)
  if (!parsed.success) {
    throw new Error(
      `Marketing script JSON failed validation: ${JSON.stringify(parsed.error.flatten())}`,
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
