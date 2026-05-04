import { SchemaType, type ResponseSchema } from '@google/generative-ai'
import { generateText, GEMINI_PRO_MODEL } from '../../shared/ai/gemini.client.js'
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
          // template: structured visual the LLM picks. Flat OBJECT with
          // every possible slot listed as optional — Gemini's
          // responseSchema doesn't model discriminated unions cleanly,
          // so we describe the universe of slots here and let Zod
          // enforce the per-kind shape downstream. The `kind` discriminator
          // tells Zod which subset is expected.
          template: {
            type: SchemaType.OBJECT,
            properties: {
              kind: {
                type: SchemaType.STRING,
                format: 'enum',
                enum: ['hero-text', 'kpi-reveal', 'list-reveal', 'mock-frame', 'chat-bubble', 'flow-diagram', 'chart'],
              },
              // hero-text + everywhere a headline-like field reads natural
              headline: { type: SchemaType.STRING },
              subhead: { type: SchemaType.STRING },
              layout: { type: SchemaType.STRING, format: 'enum', enum: ['center', 'left', 'burst'] },
              // kpi-reveal
              metric: { type: SchemaType.STRING },
              value: { type: SchemaType.STRING },
              sub: { type: SchemaType.STRING },
              trend: { type: SchemaType.STRING, format: 'enum', enum: ['up', 'down', 'flat'] },
              // list-reveal + chart + flow-diagram + mock-frame have a title
              title: { type: SchemaType.STRING },
              items: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    text: { type: SchemaType.STRING },
                    icon: { type: SchemaType.STRING },
                  },
                  required: ['text'],
                },
              },
              // mock-frame
              url: { type: SchemaType.STRING },
              appName: { type: SchemaType.STRING },
              cards: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    title: { type: SchemaType.STRING },
                    subtitle: { type: SchemaType.STRING },
                    pillText: { type: SchemaType.STRING },
                    pillTone: { type: SchemaType.STRING, format: 'enum', enum: ['accent', 'success', 'warning', 'danger', 'muted'] },
                  },
                  required: ['title'],
                },
              },
              // chat-bubble
              question: { type: SchemaType.STRING },
              answer: { type: SchemaType.STRING },
              // flow-diagram
              nodes: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    icon: { type: SchemaType.STRING },
                    label: { type: SchemaType.STRING },
                    accent: { type: SchemaType.BOOLEAN },
                  },
                  required: ['icon', 'label'],
                },
              },
              // chart
              type: { type: SchemaType.STRING, format: 'enum', enum: ['bar', 'line'] },
              points: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    label: { type: SchemaType.STRING },
                    value: { type: SchemaType.NUMBER },
                  },
                  required: ['label', 'value'],
                },
              },
            },
            required: ['kind'],
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
  /** Visual style — drives whether Gemini fills every scene with a real
   *  screenshot (screenshotIndex set, no mock) or with a designed mock
   *  (screenshotIndex=null, mock set). NOT mixed within a video. */
  visualMode?: 'screenshots' | 'mocks'
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
/** Style seeds rotated per generation to fight Gemini's tendency to
 *  converge on the same "browser frame + bento + chat" sequence every
 *  time it sees the same product. Each seed pushes a distinct visual
 *  direction + a different mode mix; one is picked at random per call.
 *
 *  This is the cheapest variety lever — no model swap, no schema
 *  change, just a textual nudge in the prompt. Gemini at temperature
 *  0.85 takes the hint and produces meaningfully different output.
 *
 *  Adding a seed here is the way to introduce a new aesthetic; don't
 *  bake it into the main prompt body where it would steamroll all the
 *  other directions. */
const STYLE_SEEDS = [
  {
    label: 'editorial',
    brief: 'Lead with a giant typographic headline (headline-burst or hero-stat). Magazine-grade type hierarchy, generous whitespace, restrained color. The video should feel like a premium product page, not a SaaS dashboard tour. Lean abstract; cap UI scenes at 1.',
  },
  {
    label: 'product-tour',
    brief: 'Lead with the product itself. Start with a cursor-click or bento UI scene that shows the user actually doing something. Save abstract scenes (hero-stat, flow-diagram) for the "why it works" beat. Treat the video as a 45-second walkthrough.',
  },
  {
    label: 'metric-driven',
    brief: 'Anchor on a single big number or metric. Use hero-stat for at least one beat, prefer counter / chart for another. The arc is "here is the claim → here is the evidence → here is the call to action". Skip cursor-click — claims, not flows.',
  },
  {
    label: 'process-flow',
    brief: 'Tell the story as a 3-step process. Use flow-diagram for the central beat (3 connected nodes with animated arrows). Bookend with logo-hero (open) and cursor-click or chat (close). Visual mode mix should feel diagrammatic.',
  },
  {
    label: 'brand-first',
    brief: 'Open with logo-hero showing the project\'s real logo at 160-180px and a bold tagline. Each subsequent scene reinforces the brand promise with one strong visual idea. Limit UI scenes to 1; favour abstract beats so the brand stays foreground.',
  },
  {
    label: 'conversational',
    brief: 'The hero of this video is the chat / AI agent angle. Use chat mode prominently — at least one full scene of user → agent dialogue with typing dots → reply. Let the conversation reveal the value prop. Other scenes support but don\'t outshine.',
  },
  {
    label: 'high-contrast',
    brief: 'Brutalist energy: oversized accent-color blocks, type at extreme scale (text-[80px]+ on hero numbers / words), minimal frames. Mostly abstract modes (headline-burst, hero-stat). When a UI scene appears, push it small and to the side — the canvas dominates.',
  },
  {
    label: 'data-density',
    brief: 'Visual mode mix should lean on chart and bento. Show real-looking dashboards, sparklines, multi-card layouts. Use the chart mode at least once with a frame-driven sweep. Abstract beats are limited to one — the rest is "look how much information the product surfaces".',
  },
] as const

/** Pick a style seed for this generation. Deterministic if a seed-id
 *  is provided (useful for tests / regenerate-with-same-look UX);
 *  otherwise random. */
function pickStyleSeed(): typeof STYLE_SEEDS[number] {
  return STYLE_SEEDS[Math.floor(Math.random() * STYLE_SEEDS.length)]!
}

/**
 * Single-scene rescue path. Two modes:
 *  - REPAIR: existing mockCode failed to compile/lint — feed the error
 *    + the broken code and ask Gemini to fix it.
 *  - GENERATE: mockCode is missing entirely (token budget exhausted in
 *    the main script generation) — pass an empty string and a generate-
 *    from-scratch directive in compileError. The prompt branches on
 *    whether mockCode is non-empty.
 *  One shot only — if it fails again, the renderer falls back to the
 *  gradient placeholder.
 */
export async function repairMockCode(args: {
  scene: { headline: string; voiceover: string; mockCode: string }
  compileError: string
}): Promise<string> {
  const isFromScratch = args.scene.mockCode.trim().length === 0
  const promptHeader = isFromScratch
    ? `Generate the mockCode for one scene of a marketing video. The main script generator skipped this scene — context: ${args.compileError}

The scene:
- Headline: "${args.scene.headline}"
- Voice-over: "${args.scene.voiceover}"

Write a fresh MockScene component that visually illustrates the headline + voice-over.`
    : `You wrote invalid TSX for one scene of a marketing video. The compiler rejected it with this error:

${args.compileError}

The scene:
- Headline: "${args.scene.headline}"
- Voice-over: "${args.scene.voiceover}"

Your previous (broken) code:
\`\`\`tsx
${args.scene.mockCode}
\`\`\`

Rewrite this scene's mockCode.`

  const userPrompt = `${promptHeader}

Hard rules (the same rules the original prompt enforced):
- Define a function exactly named \`MockScene\` taking \`{ branding }\` as its only prop.
- DO NOT \`import\` or \`require\` anything. \`React\`, \`Remotion\`, and \`branding\` are passed in as parameters.
- DO NOT call \`fetch\`, \`new XMLHttpRequest\`, \`eval\`, \`new Function\`, \`document.write\`, \`window.open\`.
- DO NOT use \`<Remotion.AccentGlow>\` (deprecated).
- Only access these branding fields: productName, accentColor, bgColor, textColor, fontFamily.
- Only invoke these Remotion symbols: interpolate, spring, useCurrentFrame, useVideoConfig, AbsoluteFill, Img, Audio, MockFrame, Pill, AnimatedCursor, Icons, Charts.
- Icons: \`Remotion.Icons[NAME]\` accepts ANY lucide-react icon name (e.g. Cpu, BookOpen, Sparkles, Workflow, Rocket, TrendingUp, Database, Video, Camera, Inbox — pick what fits the scene). The full lucide catalog is exposed; if the icon exists in lucide-react, you can use it. Aliases also work: Message → MessageSquare, Volume → Volume2, BarChart → BarChart2, Trash → Trash2, Share → Share2.
- Outer element: \`<Remotion.AbsoluteFill className='flex items-center justify-center p-10'>\` — no background, no overflow-hidden.
- Use \`<Remotion.MockFrame tone='light'>\` for UI mocks.
- Static styling via Tailwind \`className\`; inline \`style={{}}\` only for animated values.
- Stay under 2500 characters.

Return ONLY the raw TSX (no markdown fences, no explanation, no surrounding prose). It will be passed straight to esbuild.`

  // Try Pro first; fall back to Flash if Pro returns empty (503 silently
  // swallowed) or throws on overload. Flash is faster and almost always
  // good enough for a single-scene mock. Cheaper too.
  // maxTokens is REQUIRED by Gemini, but you only pay for actually-
  // generated tokens — set it high so we never get a truncated mid-TSX
  // response ("Unexpected end of file"). The compiler caps the SOURCE
  // at 6000 chars (~1500 tokens), so even if the model goes long, the
  // input rejection bounds it. Gemini 2.5 Pro / Flash both support up
  // to 65536 output tokens.
  const MAX_OUT = 32_000
  let code: string
  try {
    const result = await generateText({
      userPrompt,
      model: GEMINI_PRO_MODEL,
      maxTokens: MAX_OUT,
      temperature: 0.4,
      json: false,
    })
    code = result.text.trim()
    if (code.length === 0) {
      console.warn('[repairMockCode] Pro returned empty — falling back to Flash')
      const flashResult = await generateText({
        userPrompt,
        // No model override = Flash (default).
        maxTokens: MAX_OUT,
        temperature: 0.4,
        json: false,
      })
      code = flashResult.text.trim()
    }
  } catch (err) {
    const message = (err as Error).message
    // 503 / overload / 429 → retry on Flash.
    if (/503|429|overload/i.test(message)) {
      console.warn(`[repairMockCode] Pro errored (${message.slice(0, 80)}) — falling back to Flash`)
      const flashResult = await generateText({
        userPrompt,
        maxTokens: MAX_OUT,
        temperature: 0.4,
        json: false,
      })
      code = flashResult.text.trim()
    } else {
      throw err
    }
  }

  // Strip markdown fences if the model added them anyway.
  if (code.startsWith('```')) {
    code = code.replace(/^```(?:tsx|jsx|ts|js)?\s*\n/, '').replace(/\n```\s*$/, '').trim()
  }
  if (code.length === 0) {
    throw new Error('repairMockCode: both Pro and Flash returned empty text')
  }
  return code
}

export async function generateMarketingScript(
  input: GenerateMarketingScriptInput,
): Promise<MarketingScript> {
  const captionList = input.screenshotCaptions
    .map((c, i) => `  [${i}] ${c}`)
    .join('\n')

  const briefBlock = input.userPrompt?.trim()
    ? `\n## Creative brief from the user (HIGHEST PRIORITY for framing — but never overrides the documentation as factual ground truth)\n\n${input.userPrompt.trim()}\n\nRespect this brief: pick the angle, audience, tone shift, and which capabilities to emphasize from it. If the brief asks for something the documentation doesn't support, stay grounded in the docs and pivot the framing — don't invent features to satisfy the brief.\n`
    : ''

  // Style seed only affects mocks mode — screenshots mode has the doc
  // visuals as the anchor and doesn't need a synthetic style nudge.
  const styleSeed = input.visualMode === 'mocks' ? pickStyleSeed() : null
  const styleSeedBlock = styleSeed
    ? `\n## Style direction for THIS generation (random per call — fights "every video looks the same")\n\n**Style: ${styleSeed.label}** — ${styleSeed.brief}\n\nThis steers the visual mix only. The script still has to be grounded in the doc + the user brief above. Do NOT mention the style label in the output.\n`
    : ''

  const userPrompt = `You are writing a 45-second marketing video script for a SaaS product feature.

The video has THREE acts:
- HOOK (4-6s): one strong opening line that makes the viewer pause their scroll. Specific to the product, not generic ("save time" / "be productive" → no).
- SCENES (3-4 scenes, 7-10s each): each scene shows ONE benefit / capability backed by a doc screenshot. The narrator says it; the headline reinforces it visually. Prefer 3 sharp scenes over 4 watered-down ones.
- CTA (4-6s): clear call-to-action with a short button label.

Total duration MUST be EXACTLY 45 seconds. Allocate the budget like this:
  hook + sum(scenes) + cta = 45.0 (±0.5 OK, NOT more).
Keep voice-over CONCISE — target **85 words total** across all parts (NOT 100; audio tags + em-dashes + ellipses each add real silence at synthesis time, so the spoken duration consistently exceeds the word-count estimate). Short punchy sentences. Sentence fragments are OK ("Built for speed."). Active verbs. No filler ("Don't forget that…", "It's also worth noting…" → cut). Better to be slightly under 45s than over.

## Source documentation

Product: ${input.productName}
Feature page: ${input.pageTitle}

Markdown content (use as the ONLY source of truth — don't invent features):
${input.pageMarkdown.slice(0, 6000)}
${briefBlock}${styleSeedBlock}

## Available screenshots (from the same doc)

${captionList || '(no screenshots available — every scene MUST have screenshotIndex: null)'}

You may set "screenshotIndex" to any integer between 0 and ${Math.max(0, input.availableScreenshots - 1)}, OR to null if a scene works better headline-only (e.g. the hook). Reuse a screenshot if the same view illustrates two benefits.

## Visuals — ${input.visualMode === 'mocks' ? 'pick a template per scene' : 'real screenshots (every scene)'}

${input.visualMode === 'mocks'
  ? `**Mode = MOCKS.** For each scene, pick ONE template kind and fill its slots. The Remotion bundle has fixed React components for each kind — animations, layout, branding (accent / text / bg colors, fontFamily) are all handled by the template. You only choose the kind and the content. Always set \`screenshotIndex: null\` in this mode.

### Available templates

\`hero-text\` — big animated headline, optional subhead. Layout variants: \`center\` (default), \`left\` (left-aligned), \`burst\` (word-by-word reveal, accent on every other word).
  Use for: opener, transitional moments, "make a big claim" scenes, the CTA-style beat before the next demo.
  Slots: \`{ kind: 'hero-text', headline: string, subhead?: string, layout?: 'center' | 'left' | 'burst' }\`

\`kpi-reveal\` — giant accent-colored number with a label above and an optional trend arrow + sub-text below.
  Use for: stat-driven moments ("3 minutes to ship", "0 lines of code", "10x faster").
  Slots: \`{ kind: 'kpi-reveal', metric: string, value: string, sub?: string, trend?: 'up' | 'down' | 'flat' }\`

\`list-reveal\` — titled list, items stagger in with optional icons in accent-tinted boxes.
  Use for: feature checklists, "what you get" enumerations, step-by-step capabilities.
  Slots: \`{ kind: 'list-reveal', title: string, items: { text: string, icon?: string }[] }\` (1-8 items, icon = any lucide name)

\`mock-frame\` — browser-chromed product window with a grid of cards (title, optional subtitle, optional pill).
  Use for: product UI shots ("dashboard", "settings", "list of items"). The frame's URL hints at the product.
  Slots: \`{ kind: 'mock-frame', appName?: string, url?: string, cards: { title, subtitle?, pillText?, pillTone?: 'accent'|'success'|'warning'|'danger'|'muted' }[] }\` (1-6 cards)

\`chat-bubble\` — Q&A inside a product chat window: user question on the right, AI answer types in on the left.
  Use for: AI assistant beats, support widget demos.
  Slots: \`{ kind: 'chat-bubble', appName?: string, question: string, answer: string }\`

\`flow-diagram\` — 2-5 nodes with icons + labels chained by arrows. One node can be \`accent: true\` (the focal one).
  Use for: pipelines, "input → AI → output" beats, multi-step transformations.
  Slots: \`{ kind: 'flow-diagram', nodes: { icon: string, label: string, accent?: boolean }[] }\` (icon = any lucide name)

\`chart\` — recharts bar / line with progressive draw-in.
  Use for: growth, comparisons, before/after metrics.
  Slots: \`{ kind: 'chart', type: 'bar' | 'line', title?: string, points: { label, value: number }[] }\` (2-12 points)

### Picking template per scene

Match the scene's idea to the template that expresses it most directly:
- "We turn X into Y" → \`flow-diagram\` with X / AI / Y nodes
- "Get instant answers" → \`chat-bubble\`
- "X% faster" / "0 to N in T" → \`kpi-reveal\`
- "Built-in features" / capability list → \`list-reveal\`
- "See the dashboard" / product surface → \`mock-frame\`
- "Growth chart" / "tickets dropped" → \`chart\`
- Hooks, CTAs, transitions, claims → \`hero-text\` (often \`burst\`)

A typical 3-4 scene video uses 3 different template kinds. Don't pick the same template twice unless the content genuinely calls for it.

### Icons (when a template has icon slots)

Any lucide-react icon name works. Reach for what fits semantically:
- AI / processing → \`Cpu\`, \`Workflow\`, \`Sparkles\`, \`Atom\`
- Documentation → \`BookOpen\`, \`FileText\`, \`Edit\`
- Communication → \`MessageSquare\`, \`Send\`, \`Mail\`
- Insights → \`TrendingUp\`, \`Activity\`, \`Search\`, \`Eye\`
- Recording → \`Video\`, \`Camera\`, \`Mic\`
- Integration → \`Plug\`, \`Link\`, \`Database\`, \`Cloud\`

Pick whatever fits. If the icon doesn't exist in lucide the runtime renders a generic square — better to pick well.`
  : `**Mode = SCREENSHOTS.** Every scene MUST have \`screenshotIndex\` set to a real doc screenshot index (0..${Math.max(0, input.availableScreenshots - 1)}) and MUST NOT include a template. If a scene has no relevant screenshot you may set \`screenshotIndex: null\` and the renderer will show the canvas color.`}

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
${input.visualMode === 'mocks'
  ? `      "screenshotIndex": null,
      "template": { "kind": "<one of hero-text|kpi-reveal|list-reveal|mock-frame|chat-bubble|flow-diagram|chart>", "...slots for that kind...": "..." },`
  : `      "screenshotIndex": 0,`}
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
    // Mocks mode benefits dramatically from Pro: Flash produces the
    // safe-but-dated "browser frame + centered card" output even with
    // explicit Linear-style directives, while Pro actually uses bento
    // layouts, perspective tilts, and proper type hierarchy. Costs
    // ~3-5x more per call (~€0.04 vs €0.01) and adds ~10-20s latency,
    // worth it for the visible quality jump on a marketing video.
    // Screenshots mode stays on Flash — script-only generation doesn't
    // need Pro.
    model: input.visualMode === 'mocks' ? GEMINI_PRO_MODEL : undefined,
    // Mocks mode emits ~2KB of TSX per scene + the JSON envelope — at 4
    // scenes that's already ~10k tokens, leaving very little headroom in
    // a 16k cap. The model was silently dropping mockCode on later scenes
    // when it ran out of room. 32k gives comfortable margin.
    maxTokens: input.visualMode === 'mocks' ? 32_000 : 16_384,
    // Mocks need a touch of extra variance — but 0.85 was over the line:
    // the model started emitting TSX with subtle syntax errors / banned
    // patterns often enough that all 4 scenes would fall back to the
    // gradient placeholder. The style seed already provides directional
    // variety, so 0.7 is enough top-up.
    temperature: input.visualMode === 'mocks' ? 0.7 : 0.6,
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
