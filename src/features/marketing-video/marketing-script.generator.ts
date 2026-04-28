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
          // Mock DSL — optional per scene. The shape mirrors MockElement
          // but flattens type-specific fields so Gemini's responseSchema
          // (which can't represent discriminated unions or recursion)
          // still constrains the output. Zod re-validates on parse.
          mock: {
            type: SchemaType.OBJECT,
            properties: {
              frame: {
                type: SchemaType.OBJECT,
                properties: {
                  url: { type: SchemaType.STRING },
                  tone: { type: SchemaType.STRING },
                },
              },
              layout: { type: SchemaType.STRING },
              elements: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    type: { type: SchemaType.STRING },
                    label: { type: SchemaType.STRING },
                    icon: { type: SchemaType.STRING },
                    statusText: { type: SchemaType.STRING },
                    statusTone: { type: SchemaType.STRING },
                    prefix: { type: SchemaType.STRING },
                    text: { type: SchemaType.STRING },
                    tone: { type: SchemaType.STRING },
                    indent: { type: SchemaType.BOOLEAN },
                    trailingHighlight: { type: SchemaType.STRING },
                    title: { type: SchemaType.STRING },
                    rows: {
                      type: SchemaType.ARRAY,
                      items: {
                        type: SchemaType.OBJECT,
                        properties: {
                          left: { type: SchemaType.STRING },
                          right: { type: SchemaType.STRING },
                          tone: { type: SchemaType.STRING },
                        },
                        required: ['left'],
                      },
                    },
                    primary: { type: SchemaType.BOOLEAN },
                    placeholder: { type: SchemaType.STRING },
                    value: { type: SchemaType.STRING },
                    focused: { type: SchemaType.BOOLEAN },
                    height: { type: SchemaType.NUMBER },
                    size: { type: SchemaType.STRING },
                    weight: { type: SchemaType.STRING },
                    from: { type: SchemaType.NUMBER },
                    to: { type: SchemaType.NUMBER },
                    suffix: { type: SchemaType.STRING },
                    initials: { type: SchemaType.STRING },
                    lineNumber: { type: SchemaType.NUMBER },
                    tokens: {
                      type: SchemaType.ARRAY,
                      items: {
                        type: SchemaType.OBJECT,
                        properties: {
                          text: { type: SchemaType.STRING },
                          tone: { type: SchemaType.STRING },
                        },
                        required: ['text'],
                      },
                    },
                    delay: { type: SchemaType.NUMBER },
                  },
                  required: ['type'],
                },
              },
            },
            required: ['elements'],
          },
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
  /** Voice tone preset selected by the user — drives which ElevenLabs
   *  audio tags Gemini should embed in the voice-over lines (punchy →
   *  [excited], calm → [short pause], etc.). Without this the script
   *  comes out flat and the voice reads it flat. */
  tone?: 'punchy' | 'calm' | 'playful' | 'serious'
  /** Optional creative brief from the user: angle, audience, feature to
   *  emphasize, tone shift. NOT a content source — the doc remains the
   *  factual ground truth, this just steers framing. Trimmed and clamped
   *  upstream by Zod. */
  userPrompt?: string
}

/** Per-tone ElevenLabs audio-tag direction. Punchy/playful want
 *  expressive tags, calm/serious want pacing tags. Length matters: 2-3
 *  tags per 45-second script is the sweet spot — more and it sounds
 *  performative, fewer and it reads flat. */
const TONE_TAG_DIRECTION: Record<NonNullable<GenerateMarketingScriptInput['tone']>, string> = {
  punchy:  'Lean expressive: [excited], [happy gasp], [laughs] sparingly. Use CAPS for one or two key words. Em-dashes (—) for punchy beats. 2-3 audio tags total across the script.',
  calm:    'Lean restrained: [short pause] for breathing room, occasional [calm] or [whispers]. Ellipses (...) once or twice MAX (they add real silence). 1-2 audio tags total.',
  playful: 'Lean cheeky: [laughs], [giggles], [whispers], occasional [sarcastic]. Use rising intonation (questions OK here, sparingly). 2-3 audio tags total.',
  serious: 'Lean understated: [short pause] for emphasis, no exclamation tags. CAPS only for one critical word. No [laughs] or [excited]. 1-2 audio tags total.',
}

/** Concrete voiceover examples per tone. Pasted into the prompt so Gemini
 *  pattern-matches against tagged prose instead of clean prose. The
 *  earlier prompt described the rules abstractly and Gemini still output
 *  flat strings — examples beat instructions for in-context steering. */
const TONE_VOICEOVER_EXAMPLES: Record<NonNullable<GenerateMarketingScriptInput['tone']>, string> = {
  punchy: `hook.voiceover:  "[excited] Stop wasting hours writing docs nobody reads. One screen recording — that's all it takes."
scenes[0].voiceover: "Hit record. Walk through the feature. The AI watches every click and turns it into a STRUCTURED guide with screenshots and voice-over."
scenes[1].voiceover: "[happy gasp] Then embed an AI chat widget on your app — it answers user questions in your own voice, sourced from your own docs."
cta.voiceover: "Stop writing docs nobody reads — try it FREE today."`,
  calm: `hook.voiceover:  "Documentation that actually serves your users. [short pause] Built around a simple idea."
scenes[0].voiceover: "You record one walkthrough. The system extracts the structure, the screenshots, and the narration — automatically."
scenes[1].voiceover: "[calm] Embed a chat widget on your product. Your users ask questions; your docs answer them."
cta.voiceover: "Give your users docs they'll actually use. [short pause] Start free today."`,
  playful: `hook.voiceover:  "Writing docs is the worst part of shipping. [laughs] Let's fix that."
scenes[0].voiceover: "Hit record, click around your product like a USER would, and — [giggles] — boom. Structured guide. Screenshots. Voice-over. Done."
scenes[1].voiceover: "Drop the AI chat widget on your app and [whispers] watch your support tickets disappear."
cta.voiceover: "Your future self thanks you. [laughs] Try it free today."`,
  serious: `hook.voiceover:  "Documentation drives adoption. [short pause] Bad documentation kills it."
scenes[0].voiceover: "One screen recording produces a structured guide — screenshots, narration, exact step order. Built from what you actually do."
scenes[1].voiceover: "An embedded AI chat widget answers user questions from your CANONICAL documentation. No hallucination, no drift."
cta.voiceover: "Stop losing users to bad docs. [short pause] Start today."`,
}

/**
 * Best-effort repair for a truncated JSON string. Walks backwards from
 * the end looking for the deepest position we can cut at and produce
 * valid JSON by appending the missing closing brackets/braces.
 *
 * Strategy: at every position `i` from the end, treat `jsonStr.slice(0, i)`
 * as the candidate, drop any trailing comma + whitespace, count
 * unbalanced `{[` and append the matching `]}` count. Try to parse. The
 * first candidate that parses wins. Bounded to prevent pathological
 * walks on huge inputs.
 *
 * Crucially handles the case the naive repair misses: truncation mid-
 * empty-object (`..., {`). The walk backs the cursor up past the bare
 * `{` to the previous valid position.
 */
function repairTruncatedJson(jsonStr: string): string | null {
  // Don't bother on inputs that don't even look like a JSON object.
  if (!jsonStr.trimStart().startsWith('{')) return null
  const minLen = Math.max(50, Math.floor(jsonStr.length * 0.1))
  // Walk back in larger steps initially, then refine — typical Gemini
  // truncation is at the END, so we don't need single-char precision
  // most of the time.
  for (let step of [1, 4, 16, 64]) {
    for (let i = jsonStr.length; i >= minLen; i -= step) {
      let candidate = jsonStr.slice(0, i)
      // Strip dangling comma, partial property, partial string literal.
      candidate = candidate.replace(/[\s,]+$/, '')
      // If we cut mid-string (open quote not closed), back up to just
      // before that open quote.
      const lastOpenQuote = candidate.lastIndexOf('"')
      if (lastOpenQuote !== -1) {
        const beforeQuote = candidate.slice(0, lastOpenQuote)
        const quotesBeforeIt = (beforeQuote.match(/(?<!\\)"/g) ?? []).length
        if (quotesBeforeIt % 2 === 0) {
          // The last quote opens a string we can't finish — back up.
          candidate = beforeQuote.replace(/[\s,:]+$/, '')
        }
      }
      // Same idea for trailing partial property "key":
      candidate = candidate.replace(/,?\s*"[^"]*"\s*:\s*$/, '')
      // Drop a bare trailing `{` or `[` — they signal a started but
      // empty container we can't reasonably close.
      candidate = candidate.replace(/[,\s]*[\{\[]\s*$/, '')
      // Now count unbalanced openers and append the matching closers.
      const openBraces = (candidate.match(/\{/g) ?? []).length
      const closeBraces = (candidate.match(/\}/g) ?? []).length
      const openBrackets = (candidate.match(/\[/g) ?? []).length
      const closeBrackets = (candidate.match(/\]/g) ?? []).length
      const needBrackets = openBrackets - closeBrackets
      const needBraces = openBraces - closeBraces
      if (needBrackets < 0 || needBraces < 0) continue
      const closed = candidate + ']'.repeat(needBrackets) + '}'.repeat(needBraces)
      try {
        JSON.parse(closed)
        return closed
      } catch {
        continue
      }
    }
    // If a coarse step found something, the inner loop already returned.
    // Otherwise fall through to a finer step.
  }
  return null
}

/** Strip half-open ElevenLabs tags Gemini sometimes produces (e.g.
 *  "[excite" or trailing "["). Without this the TTS reads the bracket out
 *  loud or drops the segment. Mirrors the helper in voiceover.service.ts. */
export function stripBrokenAudioTags(text: string): string {
  let cleaned = text
  cleaned = cleaned.replace(/\s*\[[^\]]*$/g, '').trim()
  cleaned = cleaned.replace(/\[\s*\]/g, '').replace(/(?:^|\s)[\[\]](?=\s|$)/g, '').trim()
  if (cleaned && !/[.!?…]$/.test(cleaned)) cleaned = cleaned + '.'
  return cleaned
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

  const userPrompt = `You are writing a 45-second marketing video script for a SaaS product feature.

The video has THREE acts:
- HOOK (4-6s): one strong opening line that makes the viewer pause their scroll. Specific to the product, not generic ("save time" / "be productive" → no).
- SCENES (3-4 scenes, 7-10s each): each scene shows ONE benefit / capability backed by a doc screenshot. The narrator says it; the headline reinforces it visually. Prefer 3 sharp scenes over 4 watered-down ones.
- CTA (4-6s): clear call-to-action with a short button label.

Total duration MUST be EXACTLY 45 seconds. Allocate the budget like this:
  hook + sum(scenes) + cta = 45.0 (±0.5 OK, NOT more).
Keep voice-over CONCISE — at ~2.3 words/second, 45s ≈ 100 words total across all parts. Short punchy sentences. Sentence fragments are OK ("Built for speed."). Active verbs. No filler ("Don't forget that…", "It's also worth noting…" → cut).

## Source documentation

Product: ${input.productName}
Feature page: ${input.pageTitle}

Markdown content (use as the ONLY source of truth — don't invent features):
${input.pageMarkdown.slice(0, 6000)}
${briefBlock}

## Available screenshots (from the same doc)

${captionList || '(no screenshots available — every scene MUST have screenshotIndex: null)'}

You may set "screenshotIndex" to any integer between 0 and ${Math.max(0, input.availableScreenshots - 1)}, OR to null if a scene works better headline-only (e.g. the hook). Reuse a screenshot if the same view illustrates two benefits.

## Visuals — screenshot OR designed mock (per scene)

Each scene picks ONE of two visual modes:

A) **Screenshot** — set \`screenshotIndex\` to a real doc screenshot. Use this when the scene is showing the actual product UI the user is documenting (the "grounded in real product" path — high credibility).

B) **Designed mock** — set \`mock\` to a DSL object describing an animated UI panel. Use this when the scene illustrates a CONCEPT the screenshots can't (a chat conversation, a terminal command, a settings transformation, a stat counter, an integration with a third-party tool, etc.). Mocks are visually polished and feel like a designed product video instead of a slideshow.

A scene MUST have ONE: either a real \`screenshotIndex\` (0..${Math.max(0, input.availableScreenshots - 1)}) or a \`mock\`. Aim for a 50/50 mix when the content allows — alternating real screens and designed mocks gives the video a great editorial rhythm. Pure-screenshot videos feel slideshow-y; pure-mock videos lose product credibility.

### Mock DSL

Set \`mock.elements\` to an array (max 12 elements) of small primitives. The renderer animates them in with a subtle stagger — set \`delay\` (seconds) per element to control timing (e.g. \`0\`, \`0.25\`, \`0.5\` for a "typing in" feel).

Optional \`mock.frame\`: \`{ url, tone }\` wraps the mock in a browser chrome with a URL bar. Use \`tone: "dark"\` for terminal/code mocks, \`"light"\` for product-UI mocks. Skip \`frame\` for floating mocks (e.g. a chat widget overlay).

Available element types (\`type\`) and their fields. ALL fields are optional unless noted; tone enum: \`default | muted | accent | success | warning | danger\`.

- \`header\`         { label*, icon, statusText, statusTone }
   Top bar with an icon + label + optional right-aligned pill ("connected").
   icons: plug, mic, check, message, search, zap, code, settings.
- \`terminalLine\`   { prefix, text*, tone, indent, trailingHighlight }
   A single line in a terminal/log. Prefix is shown muted ("\$", ">", "↳").
- \`blinkingCursor\` {}
   Add at the bottom of a terminal block.
- \`card\`           { title, rows: [{ left*, right, tone }] }
   Stat cards / settings rows. Right value is colored by tone (good for KPIs).
- \`pill\`           { text*, tone }
   Inline badge ("Pro plan", "10x faster", "AI-powered").
- \`pulsingDot\`     { tone, size }
   Live-indicator dot (use with text near it).
- \`button\`         { label*, primary }
   Primary uses brand accent + shadow; non-primary is outlined.
- \`input\`          { placeholder, value, focused }
   Text field; \`focused: true\` adds an accent ring.
- \`text\`           { text*, size: xs|sm|md|lg|xl, tone, weight: normal|bold }
   Plain text line. Use for prompts ("Ask anything"), subtitles, taglines.
- \`counter\`        { from*, to*, prefix, suffix }
   Big animated number that ticks from \`from\` to \`to\` over 1.2s. Great for "+340 docs" / "98% uptime".
- \`avatar\`         { initials*, tone }
   Round badge with 1-3 letters. Use for chat-style mocks.
- \`codeLine\`       { lineNumber, tokens: [{ text*, tone }] }
   One line of pseudo syntax-highlighted code. Use \`tone: accent\` for keywords, \`muted\` for comments.
- \`spacer\`         { height }
   Vertical gap (default 12px).

Example mock — a Claude/MCP terminal scene:
\`\`\`json
{
  "frame": { "url": "claude · mcp.${input.productName.toLowerCase().replace(/\s+/g, '-')}.com", "tone": "dark" },
  "elements": [
    { "type": "header", "icon": "plug", "label": "Claude · MCP", "statusText": "connected", "statusTone": "success", "delay": 0 },
    { "type": "terminalLine", "prefix": ">", "text": "docs.search", "tone": "muted", "delay": 0.3 },
    { "type": "terminalLine", "indent": true, "text": "query: 'connect stripe'", "tone": "accent", "delay": 0.5 },
    { "type": "terminalLine", "prefix": "↳", "text": "found 3 pages", "trailingHighlight": "200 ok", "delay": 0.9 },
    { "type": "blinkingCursor", "delay": 1.4 }
  ]
}
\`\`\`

Example mock — a stat dashboard scene:
\`\`\`json
{
  "frame": { "url": "${input.productName.toLowerCase()}.app/dashboard", "tone": "light" },
  "elements": [
    { "type": "header", "icon": "zap", "label": "This week", "delay": 0 },
    { "type": "counter", "from": 0, "to": 1247, "suffix": " docs read", "delay": 0.2 },
    { "type": "card", "title": "Top pages", "rows": [
      { "left": "Quick start", "right": "+412", "tone": "success" },
      { "left": "API reference", "right": "+318", "tone": "success" },
      { "left": "Migration guide", "right": "+287", "tone": "accent" }
    ], "delay": 0.6 }
  ]
}
\`\`\`

Pick mock vs screenshot per scene as fits — don't force mocks where a real screenshot is more telling.

## Language

Write the entire script in **${input.language}**. Do not switch languages mid-script. UI labels in another language stay verbatim in quotes.

## Tone

Confident, specific, benefit-driven. No buzzwords ("revolutionary", "next-gen", "game-changer" → all banned). Active voice. Concrete verbs.

## Voice-over delivery — ElevenLabs v3 formatting (CRITICAL)

The voiceover strings in the JSON output will be fed to ElevenLabs v3 TTS as a single concatenated narration. Without delivery cues the read comes out flat regardless of voice settings. Bake in the cues:

**Punctuation drives delivery:**
- Em dash (—) creates a short, punchy pause. Use it for emphasis or beat changes.
- Ellipsis (...) creates trailing silence — uses real seconds, so use SPARINGLY (max once across the whole script).
- CAPS for one or two key words signal vocal stress (NOT whole sentences).
- Questions (with ?) create natural rising intonation; only use if the tone allows.

**Audio tags are stage directions** — they MUST appear in the voiceover strings, placed BETWEEN sentences (never mid-sentence). The whole point of this script is that ElevenLabs reads it expressively, not flat. A voiceover string with NO tags AND no emphatic punctuation is a FAILED output and will be regenerated.

Available tags:
Emotional: [excited], [happy], [calm]
Reactions: [laughs], [giggles], [happy gasp], [sighs]
Delivery: [whispers], [cheerfully], [sarcastic]
Pacing: [short pause]

Tags go inside the relevant voiceover string (hook.voiceover / scenes[i].voiceover / cta.voiceover). They count as 0 spoken words for the word-count budget.

### REQUIRED for the selected voice tone (${input.tone ?? 'punchy'})

${TONE_TAG_DIRECTION[input.tone ?? 'punchy']}

This is a MUST, not a suggestion. Across the 5 voiceover strings (1 hook + 3-4 scenes + 1 cta), you MUST land 2-3 audio tags total + at least one CAPS-emphasized word + at least one em-dash for a punchy beat. Don't skip them on the grounds of "the prose reads fine without them" — flat prose is the bug we are fixing.

### Concrete voiceover examples for tone="${input.tone ?? 'punchy'}"

These are EXACTLY the shape voiceover strings should have. Notice tags between sentences, em-dashes for beats, occasional CAPS:

${TONE_VOICEOVER_EXAMPLES[input.tone ?? 'punchy']}

## Output

Return ONLY valid JSON matching this exact shape, no markdown fences, no preamble. Notice the voiceover values — they include audio tags + emphatic punctuation as REQUIRED above. Match this style:

{
  "hook": {
    "voiceover": "[excited] Short opening narration — with one CAPS word for stress.",
    "headline": "Big on-screen headline 3-7 words",
    "durationSeconds": 5
  },
  "scenes": [
    {
      "voiceover": "Narration for scene 1 with a concrete benefit. [short pause] A second sentence for context.",
      "headline": "On-screen headline scene 1",
      "subhead": "Optional supporting line under headline",
      "screenshotIndex": 0,
      "durationSeconds": 10
    }
  ],
  "cta": {
    "voiceover": "Closing line with the call to action — with one CAPS word.",
    "headline": "Final on-screen headline",
    "buttonLabel": "Try ${input.productName} free",
    "durationSeconds": 5
  },
  "totalDurationSeconds": 45,
  "language": "${input.language}"
}

Final check before returning: hook.durationSeconds + sum(scenes[].durationSeconds) + cta.durationSeconds MUST equal totalDurationSeconds. Word counts MUST be realistic at 2.3 words/second.`

  const result = await generateText({
    userPrompt,
    // Bumped to 8192: with audio tags + emphasis + 4 scenes the response
    // can run long, and a truncated JSON puts us in the repair-or-die
    // path. 8192 gives enough headroom to never truncate a 45s script
    // even in the most verbose tones / languages.
    maxTokens: 8192,
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
    // Truncation repair: walk backwards looking for the last syntactically
    // balanced point we can close cleanly. Handles cases the naive
    // "append closing brackets" repair misses — e.g. truncation mid-
    // partial-object (`{scene1}, {`) where appending `]}` produces
    // `{scene1}, {]}` which is invalid.
    const repaired = repairTruncatedJson(jsonStr)
    if (repaired !== null) {
      try {
        parsedJson = JSON.parse(repaired)
        console.warn('[marketing-script] JSON repaired after parse error:', (err as Error).message)
      } catch {
        console.error('[marketing-script] JSON parse failed. First 500 chars:', jsonStr.slice(0, 500))
        throw new Error(`Marketing script JSON parse failed: ${(err as Error).message}`)
      }
    } else {
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
  // an index that doesn't exist. Also strip any half-open ElevenLabs audio
  // tags Gemini may have left behind (e.g. "[excite" with no closing
  // bracket) — those break the TTS read.
  const max = input.availableScreenshots - 1
  const validated = parsed.data as MarketingScript
  const clamped: MarketingScript = {
    ...validated,
    hook: {
      ...validated.hook,
      voiceover: stripBrokenAudioTags(validated.hook.voiceover),
    },
    scenes: validated.scenes.map((s) => ({
      ...s,
      voiceover: stripBrokenAudioTags(s.voiceover),
      screenshotIndex:
        s.screenshotIndex == null
          ? null
          : Math.max(0, Math.min(max, s.screenshotIndex)),
    })),
    cta: {
      ...validated.cta,
      voiceover: stripBrokenAudioTags(validated.cta.voiceover),
    },
  }

  return clamped
}
