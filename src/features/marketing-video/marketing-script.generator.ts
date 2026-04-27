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

  const parsed = MarketingScriptSchema.safeParse(JSON.parse(result.text))
  if (!parsed.success) {
    throw new Error(
      `Marketing script JSON failed validation: ${JSON.stringify(parsed.error.flatten())}`,
    )
  }

  // Clamp screenshotIndex into a valid range — Gemini sometimes references
  // an index that doesn't exist.
  const max = input.availableScreenshots - 1
  const clamped: MarketingScript = {
    ...parsed.data,
    scenes: parsed.data.scenes.map((s) => ({
      ...s,
      screenshotIndex:
        s.screenshotIndex == null
          ? null
          : Math.max(0, Math.min(max, s.screenshotIndex)),
    })),
  }

  return clamped
}
