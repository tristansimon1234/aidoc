import { SchemaType, type ResponseSchema } from '@google/generative-ai'
import { generateSonnetText } from '../../shared/ai/anthropic.client.js'
import { MarketingScriptSchema } from './marketing-video.schema.js'
import type { MarketingScript } from './marketing-video.types.js'

/**
 * Native Gemini schema mirroring MarketingScriptSchema. Passed as
 * `responseSchema` so the API server-side-constrains the output to this exact
 * shape — no missing fields, no rename drift, no envelope wrappers. We still
 * Zod-validate after parsing as defence in depth (string min-length, etc.,
 * which Gemini's schema can't express).
 */
/**
 * Skeleton schema — same shape as RESPONSE_SCHEMA but WITHOUT mockCode
 * on scenes. Used by the first stage of the two-stage generation: get
 * the script structure (hook + voiceovers + headlines + cta + timing)
 * without the heavy TSX. Per-scene mockCode is then generated in
 * parallel by N independent calls.
 */
export const SKELETON_RESPONSE_SCHEMA: ResponseSchema = {
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
          // Architect-picked mode for the per-scene designer call.
          // One of the 8 ids in SCENE_MODES. Stage 2 looks up the
          // matching reference template by id.
          visualMode: { type: SchemaType.STRING },
          // Concrete brief: 2-3 sentences naming specific elements,
          // numbers, motion. Stage 2 implements this brief in TSX.
          visualBrief: { type: SchemaType.STRING },
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
    // Architect-picked aesthetic for the whole video. One of
    // STYLE_SEEDS labels — orchestrator looks up the brief and feeds
    // it to designer agents. Optional: when the model omits it, the
    // orchestrator falls back to a random seed.
    styleSeed: { type: SchemaType.STRING },
  },
  required: ['hook', 'scenes', 'cta', 'totalDurationSeconds', 'language'],
}

/** Backward-compat alias — older imports may still expect RESPONSE_SCHEMA. */
export const RESPONSE_SCHEMA = SKELETON_RESPONSE_SCHEMA

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
  tone?: import('./marketing-video.types.js').VoiceTone
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
const TONE_TAG_DIRECTION: Record<NonNullable<GenerateMarketingScriptInput['tone']>, string> = {
  punchy:         'Lean expressive: [excited], [happy gasp], [laughs] sparingly. Use CAPS for one or two key words. Em-dashes (—) for punchy beats. 2-3 audio tags total across the script.',
  calm:           'Lean restrained: [short pause] for breathing room, occasional [calm] or [whispers]. Ellipses (...) once or twice MAX (they add real silence). 1-2 audio tags total.',
  playful:        'Lean cheeky: [laughs], [giggles], [whispers], occasional [sarcastic]. Use rising intonation (questions OK here, sparingly). 2-3 audio tags total.',
  serious:        'Lean understated: [short pause] for emphasis, no exclamation tags. CAPS only for one critical word. No [laughs] or [excited]. 1-2 audio tags total.',
  confident:      'Lean warm-authority: [short pause] between key claims, occasional CAPS for emphasis. No [laughs] or [excited] — too performative for founder pitch. 2 audio tags total.',
  inspirational:  'Lean building: [building] / [excited] sparingly, CAPS on the climax word, em-dashes for breaths between rising phrases. 2-3 audio tags total.',
  conversational: 'Lean natural-podcast: [short pause] for thinking pauses, occasional rising intonation, no exclamatory tags. CAPS rare. 1-2 audio tags total.',
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
  confident: `hook.voiceover:  "Here's what we built. [short pause] Documentation that maintains itself, sourced from how your product ACTUALLY works."
scenes[0].voiceover: "You record one walkthrough — the AI does the rest. Structure, screenshots, narration. The doc your team should have written months ago."
scenes[1].voiceover: "Then it gets smarter. [short pause] An embedded chat widget answers your users in your voice, grounded in your real documentation."
cta.voiceover: "Documentation isn't a chore anymore. Start free — your users will thank you."`,
  inspirational: `hook.voiceover:  "[building] What if your documentation could keep pace with your product? [short pause] What if it could grow WITH you?"
scenes[0].voiceover: "One recording becomes a living guide — structured, narrated, screenshot-ready. The kind of doc that makes new users feel SEEN."
scenes[1].voiceover: "An AI assistant answers them instantly. No more lost users. No more silent frustration. [short pause] Just clarity."
cta.voiceover: "Build the docs your product DESERVES. [short pause] Start free today."`,
  conversational: `hook.voiceover:  "Okay so — writing docs is brutal. Let me show you what we did about it."
scenes[0].voiceover: "You hit record, walk through the feature like a user would, and the AI just... handles it. Steps, screenshots, voice-over — all there."
scenes[1].voiceover: "And then there's a chat widget you can drop on your app. Your users ask stuff, it answers from YOUR docs. No more support tickets at 2am."
cta.voiceover: "Honestly, you should just try it. [short pause] Free, takes two minutes."`,
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
    brief: 'Magazine-grade type hierarchy on the headline panel + minimal restrained mocks (hero-stat with eyebrow + giant number, logo-hero, clean flow-diagram). Generous whitespace, restrained color. Feel like a premium product page, not a SaaS dashboard tour. Lean abstract; cap UI scenes at 1.',
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
    brief: 'Brutalist energy: oversized accent-color blocks, type at extreme scale (text-[80px]+ on hero numbers), minimal frames. Mostly abstract modes (hero-stat with giant numbers, logo-hero, bold flow-diagram). When a UI scene appears, push it small and to the side — the canvas dominates.',
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
  // Sonnet 4.6 handles single-scene TSX rescue cleanly. maxTokens at
  // 16k gives comfortable margin over the 9000-char compile cap; the
  // input rejection in mock-code.compiler.ts bounds the source size
  // even if the model goes long. No fallback model — if Sonnet errors
  // (rate-limit / overload), we let it bubble up and the calling
  // pipeline routes through `applyDeterministicFallback`.
  const MAX_OUT = 16_000
  const result = await generateSonnetText({
    userPrompt,
    maxTokens: MAX_OUT,
    temperature: 0.5,
  })
  let code = result.text.trim()

  // Strip markdown fences if the model added them anyway.
  if (code.startsWith('```')) {
    code = code.replace(/^```(?:tsx|jsx|ts|js)?\s*\n/, '').replace(/\n```\s*$/, '').trim()
  }
  if (code.length === 0) {
    throw new Error('repairMockCode: Sonnet returned empty text')
  }
  return code
}

// =============================================================================
// Stage 2: Per-scene mockCode generation (parallel, one call per scene)
// =============================================================================

/** One of N scene treatments. The orchestrator pre-assigns one per
 *  scene (no dupes within a video) so each per-scene call's prompt
 *  is FOCUSED on a single shape — that's what kills the monolithic
 *  prompt's tendency to converge on "browser frame + bento + chat"
 *  every time. */
interface SceneMode {
  id: string
  /** True for canvas-driven beats (no browser frame). False for
   *  product-surface beats (MockFrame inside). The orchestrator
   *  balances the two so a video isn't 4 abstract beats (no product
   *  visible) or 4 UI tours (boring). */
  isAbstract: boolean
  description: string
  /** TSX reference variants. The per-scene prompt shows ALL of them
   *  with the framing "here's how others have solved this — pick one,
   *  mix, or push further". Multiple variants per mode is the lever
   *  against the "every hero-stat looks identical across videos"
   *  failure mode of single-reference prompts. */
  references: readonly string[]
}

const SCENE_MODES: readonly SceneMode[] = [
  {
    id: 'hero-stat',
    isAbstract: true,
    description:
      'NO browser frame. Tiny eyebrow label + GIANT accent-colored number / metric (text-[100px]+ font-black) + one-line subhead. Counter ticks up across 1.6s then keeps drifting upward (~+1 every 30 frames) so the metric feels live the whole scene. Use for any "look at this number" / metric beat.',
    references: [
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const labelT = Remotion.spring({ frame: f, fps, config: { damping: 16, stiffness: 100 } })
  const numT = Remotion.spring({ frame: f - 8, fps, config: { damping: 14, stiffness: 90 } })
  const subT = Remotion.spring({ frame: f - 22, fps, config: { damping: 16, stiffness: 100 } })
  const labelOp = Remotion.interpolate(labelT, [0, 1], [0, 1])
  const numOp = Remotion.interpolate(numT, [0, 1], [0, 1])
  const numY = Remotion.interpolate(numT, [0, 1], [24, 0])
  const subOp = Remotion.interpolate(subT, [0, 1], [0, 1])
  const ease = 1 - Math.pow(1 - Remotion.interpolate(f, [12, 12 + fps * 1.6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }), 3)
  const post = Math.max(0, f - (12 + fps * 1.6))
  const value = Math.round(12_847 * ease + post / 30)
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-12'>
      <div className='flex flex-col items-center gap-5 text-center'>
        <div className='text-[11px] font-bold tracking-[0.18em] uppercase text-zinc-500' style={{ opacity: labelOp }}>Queries this month</div>
        <div className='text-[120px] font-black leading-none tracking-tight tabular-nums' style={{ color: branding.accentColor, opacity: numOp, transform: \`translateY(\${numY}px)\`, textShadow: \`0 8px 40px \${branding.accentColor}44\` }}>{value.toLocaleString()}</div>
        <div className='text-[20px] font-medium text-zinc-700 tracking-tight max-w-[600px]' style={{ opacity: subOp }}>and growing — your docs are answering for you.</div>
      </div>
    </Remotion.AbsoluteFill>
  )
}`,
      // Variant: percentage with progress bar that fills + a comparison
      // line ("vs last week 64%"). Different visual rhythm — fewer
      // numbers, more "see the proof" via the bar drawing in.
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const labelOp = Remotion.interpolate(f, [0, 12], [0, 1], { extrapolateRight: 'clamp' })
  const numEase = Remotion.interpolate(f, [10, 10 + fps * 1.4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const target = 92
  const value = Math.round(target * (1 - Math.pow(1 - numEase, 3)))
  const barFill = Remotion.interpolate(f, [20, 20 + fps * 1.6], [0, target / 100], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const cmpOp = Remotion.interpolate(f, [50, 65], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-12'>
      <div className='flex flex-col items-start gap-6 w-[640px]'>
        <div className='text-[11px] font-bold tracking-[0.18em] uppercase text-zinc-500' style={{ opacity: labelOp }}>Resolution rate</div>
        <div className='flex items-baseline gap-3'>
          <div className='text-[140px] font-black leading-none tracking-tight tabular-nums' style={{ color: branding.accentColor }}>{value}</div>
          <div className='text-[64px] font-black leading-none tracking-tight' style={{ color: branding.accentColor, opacity: 0.6 }}>%</div>
        </div>
        <div className='w-full h-3 rounded-full overflow-hidden bg-zinc-100'>
          <div className='h-full rounded-full' style={{ width: \`\${barFill * 100}%\`, background: \`linear-gradient(90deg, \${branding.accentColor}, \${branding.accentColor}CC)\`, boxShadow: \`0 0 24px \${branding.accentColor}66\` }} />
        </div>
        <div className='text-[14px] font-medium text-zinc-600' style={{ opacity: cmpOp }}>vs 64% last week — <span style={{ color: branding.accentColor, fontWeight: 700 }}>+28pts</span></div>
      </div>
    </Remotion.AbsoluteFill>
  )
}`,
    ],
  },
  {
    id: 'bento',
    isAbstract: false,
    description:
      'Browser frame WITH perspective tilt (rotateY -3deg, rotateX 2deg). Mixed-size grid: one big tall card on the left (col-span-2 row-span-2) tinted in branding.accentColor, two smaller stacked cards on the right. Counter ticks live, latency jitters within a tight band, active-pill dot pulses — all CONTINUOUS motion through the whole scene.',
    references: [
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const ease = (start) => Remotion.spring({ frame: f - start, fps, config: { damping: 16, stiffness: 90 } })
  const enter = (t) => ({ opacity: Remotion.interpolate(t, [0, 1], [0, 1]), transform: \`translateY(\${Remotion.interpolate(t, [0, 1], [16, 0])}px)\` })
  const tilt = Remotion.interpolate(ease(0), [0, 1], [-2, -1])
  const liveCount = 4 + Math.floor(f / 90)
  const latency = Math.round(178 + 6 * Math.sin(f / 16))
  const dotPulse = 0.55 + 0.45 * Math.sin(f / 12)
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10'>
      <div className='relative w-[800px]' style={{ transform: \`perspective(1400px) rotateY(\${tilt}deg) rotateX(2deg)\` }}>
        <Remotion.MockFrame url={\`\${branding.productName.toLowerCase()}.app/analytics\`} tone='light'>
          <div className='p-5 grid grid-cols-3 gap-3 h-full'>
            <div className='col-span-2 row-span-2 rounded-2xl p-5 flex flex-col justify-end' style={{ ...enter(ease(8)), background: \`linear-gradient(135deg, \${branding.accentColor}15, \${branding.accentColor}05)\`, border: \`1px solid \${branding.accentColor}25\` }}>
              <div className='text-[10px] font-bold tracking-widest uppercase' style={{ color: branding.accentColor }}>This week</div>
              <div className='text-[64px] font-black tracking-tight leading-none tabular-nums mt-1' style={{ color: branding.accentColor }}>+38%</div>
              <div className='text-[13px] font-medium text-zinc-600 mt-1.5'>Doc queries answered</div>
            </div>
            <div className='rounded-2xl bg-white border border-zinc-200/80 p-4 flex flex-col gap-1' style={{ ...enter(ease(20)), boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
              <div className='text-[10px] font-semibold uppercase tracking-wider text-zinc-500'>Connected</div>
              <div className='text-[28px] font-bold tabular-nums text-zinc-900'>{liveCount}</div>
              <Remotion.Pill tone='success' dot style={{ opacity: dotPulse }}>active</Remotion.Pill>
            </div>
            <div className='rounded-2xl bg-zinc-900 p-4 flex flex-col gap-1' style={enter(ease(28))}>
              <div className='text-[10px] font-semibold uppercase tracking-wider text-zinc-400'>Latency</div>
              <div className='text-[28px] font-bold tabular-nums text-white'>{latency}ms</div>
              <div className='text-[11px] text-emerald-400 font-medium'>↓ 12ms</div>
            </div>
          </div>
        </Remotion.MockFrame>
      </div>
    </Remotion.AbsoluteFill>
  )
}`,
      // Variant: vertical bento with activity feed on the left + 2x2 grid
      // on the right. Different rhythm — feed scrolls (sustained motion
      // via translateY) while right-side stat cards pop in.
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const ease = (start) => Remotion.spring({ frame: f - start, fps, config: { damping: 16, stiffness: 90 } })
  const enter = (t) => ({ opacity: Remotion.interpolate(t, [0, 1], [0, 1]) })
  const feedScroll = -Remotion.interpolate(f, [40, 200], [0, 60], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const items = [
    { who: 'Sarah K.', what: 'asked about API limits', t: '12s ago' },
    { who: 'Mateo L.', what: 'opened "Auth setup"', t: '34s ago' },
    { who: 'Emma D.', what: 'completed onboarding', t: '1m ago' },
    { who: 'Ravi P.', what: 'shared a link', t: '2m ago' },
  ]
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10'>
      <div className='w-[820px]' style={{ transform: 'perspective(1400px) rotateX(2deg)' }}>
        <Remotion.MockFrame url={\`\${branding.productName.toLowerCase()}.app\`} tone='light'>
          <div className='p-4 grid grid-cols-5 gap-3 h-full'>
            <div className='col-span-3 rounded-2xl bg-white border border-zinc-200/80 p-4 overflow-hidden flex flex-col' style={{ ...enter(ease(0)), boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
              <div className='flex items-center gap-2 pb-3 border-b border-zinc-100'>
                <Remotion.Icons.Activity size={14} color={branding.accentColor} />
                <div className='text-[12px] font-bold tracking-tight text-zinc-900'>Live activity</div>
                <Remotion.Pill tone='success' dot style={{ marginLeft: 'auto', opacity: 0.6 + 0.4 * Math.sin(f / 12) }}>live</Remotion.Pill>
              </div>
              <div className='relative flex-1 overflow-hidden mt-2'>
                <div style={{ transform: \`translateY(\${feedScroll}px)\` }}>
                  {items.map((it, i) => (
                    <div key={i} className='flex items-center gap-3 py-2.5 border-b border-zinc-100/70'>
                      <div className='w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0' style={{ background: branding.accentColor }}>{it.who.split(' ').map(p => p[0]).join('')}</div>
                      <div className='flex-1 min-w-0'><div className='text-[12px] font-semibold text-zinc-900 truncate'>{it.who}</div><div className='text-[11px] text-zinc-500 truncate'>{it.what}</div></div>
                      <div className='text-[10px] text-zinc-400'>{it.t}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className='col-span-2 grid grid-rows-2 gap-3'>
              <div className='rounded-2xl p-4 flex flex-col justify-between' style={{ ...enter(ease(10)), background: \`linear-gradient(135deg, \${branding.accentColor}, \${branding.accentColor}CC)\` }}>
                <div className='text-[10px] font-bold tracking-widest uppercase text-white/80'>Resolved</div>
                <div className='text-[42px] font-black tracking-tight leading-none tabular-nums text-white'>{Math.floor(f / 8)}</div>
              </div>
              <div className='rounded-2xl bg-zinc-50 border border-zinc-200/70 p-4 flex flex-col justify-between' style={enter(ease(22))}>
                <div className='text-[10px] font-semibold uppercase tracking-wider text-zinc-500'>Avg time</div>
                <div className='text-[28px] font-bold tracking-tight tabular-nums text-zinc-900'>{(2.4 + 0.05 * Math.sin(f / 14)).toFixed(1)}s</div>
              </div>
            </div>
          </div>
        </Remotion.MockFrame>
      </div>
    </Remotion.AbsoluteFill>
  )
}`,
    ],
  },
  {
    id: 'chat',
    isAbstract: false,
    description:
      'Browser frame, chat UI. User bubble (top, right-aligned, accentColor background) + AI typing dots → AI reply, all in PRE-ALLOCATED slots so nothing reflows. The typing-dots placeholder cross-fades into the reply in the SAME slot via absolute positioning. Bubble copy fits ONE line at max-w-[75%]. Container is justify-start (top-aligned), NOT vertically centered. Cursor blink in user bubble for sustained motion.',
    references: [
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const userT = Remotion.spring({ frame: f - 6, fps, config: { damping: 16, stiffness: 90 } })
  const userOp = Remotion.interpolate(userT, [0, 1], [0, 1])
  const userY = Remotion.interpolate(userT, [0, 1], [12, 0])
  const dotsOp = Remotion.interpolate(f, [22, 28, 64, 70], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const replyT = Remotion.spring({ frame: f - 70, fps, config: { damping: 16, stiffness: 90 } })
  const replyOp = Remotion.interpolate(replyT, [0, 1], [0, 1])
  const dot = (i) => 0.3 + 0.7 * Math.abs(Math.sin((f - i * 6) / 8))
  const blink = (f % 30) < 15 ? 1 : 0
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10'>
      <Remotion.MockFrame url='claude.ai/chat' tone='light'>
        <div className='h-full flex flex-col p-6 gap-4'>
          <div className='flex items-center gap-2'>
            <Remotion.Icons.Cpu size={14} color={branding.accentColor} />
            <span className='text-[12px] font-bold tracking-tight text-zinc-900'>{branding.productName}</span>
            <span className='ml-auto'><Remotion.Pill tone='success' dot>connected</Remotion.Pill></span>
          </div>
          <div className='self-end max-w-[75%]' style={{ opacity: userOp, transform: \`translateY(\${userY}px)\` }}>
            <div className='rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] text-white' style={{ background: branding.accentColor }}>
              How do I connect Stripe?<span className='inline-block w-[2px] h-[14px] ml-0.5 align-middle bg-white' style={{ opacity: blink }} />
            </div>
          </div>
          <div className='self-start max-w-[75%] flex items-start gap-2.5'>
            <div className='w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0' style={{ background: branding.accentColor }}>AI</div>
            <div className='relative min-h-[44px] flex-1'>
              <div className='absolute inset-0 flex items-center gap-1.5 px-4 rounded-2xl rounded-tl-md bg-zinc-100 border border-zinc-200/70' style={{ opacity: dotsOp }}>
                {[0,1,2].map(i => <span key={i} className='w-2 h-2 rounded-full bg-zinc-500' style={{ opacity: dot(i) }} />)}
              </div>
              <div className='rounded-2xl rounded-tl-md px-4 py-2.5 bg-zinc-100 border border-zinc-200/70 text-[15px] text-zinc-800' style={{ opacity: replyOp }}>
                Open Settings → Integrations, paste your key, hit save.
              </div>
            </div>
          </div>
        </div>
      </Remotion.MockFrame>
    </Remotion.AbsoluteFill>
  )
}`,
      // Variant: question + multi-step "thinking" pills (3 steps appear
      // sequentially — "Reading docs...", "Found relevant section",
      // "Drafting answer") + final answer reveals. More cinematic feel
      // than typing dots; emphasises the AI reasoning.
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const qT = Remotion.spring({ frame: f - 4, fps, config: { damping: 16, stiffness: 90 } })
  const qOp = Remotion.interpolate(qT, [0, 1], [0, 1])
  const stepIn = (start) => Remotion.interpolate(f, [start, start + 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const ansT = Remotion.spring({ frame: f - 90, fps, config: { damping: 16, stiffness: 90 } })
  const ansOp = Remotion.interpolate(ansT, [0, 1], [0, 1])
  const steps = [
    { icon: 'BookOpen', label: 'Reading documentation', start: 22 },
    { icon: 'Filter', label: 'Found 3 relevant sections', start: 44 },
    { icon: 'PenTool', label: 'Drafting answer', start: 66 },
  ]
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10'>
      <Remotion.MockFrame url={\`\${branding.productName.toLowerCase()}.app/ask\`} tone='light'>
        <div className='h-full flex flex-col p-6 gap-3'>
          <div className='self-end max-w-[80%]' style={{ opacity: qOp }}>
            <div className='rounded-2xl rounded-br-md px-4 py-2.5 text-[14px] text-white' style={{ background: branding.accentColor }}>What's the difference between teams and orgs?</div>
          </div>
          <div className='flex flex-col gap-2 mt-1'>
            {steps.map((s, i) => {
              const Ico = Remotion.Icons[s.icon]
              const op = stepIn(s.start)
              const done = f > s.start + 18
              return (
                <div key={i} className='flex items-center gap-2.5' style={{ opacity: op }}>
                  <div className='w-6 h-6 rounded-full flex items-center justify-center' style={{ background: done ? branding.accentColor : \`\${branding.accentColor}22\` }}>
                    {done ? <Remotion.Icons.Check size={12} color='#FFFFFF' /> : <Ico size={12} color={branding.accentColor} />}
                  </div>
                  <span className='text-[12px] font-medium text-zinc-700'>{s.label}</span>
                </div>
              )
            })}
          </div>
          <div className='mt-auto rounded-2xl rounded-tl-md px-4 py-3 border' style={{ opacity: ansOp, background: \`\${branding.accentColor}08\`, borderColor: \`\${branding.accentColor}33\` }}>
            <div className='text-[10px] font-bold tracking-widest uppercase mb-1' style={{ color: branding.accentColor }}>Answer</div>
            <div className='text-[14px] text-zinc-800 leading-snug'>Teams scope billing and projects; orgs scope teams and SSO. Switch in Settings → Workspace.</div>
          </div>
        </div>
      </Remotion.MockFrame>
    </Remotion.AbsoluteFill>
  )
}`,
    ],
  },
  {
    id: 'chart',
    isAbstract: false,
    description:
      'Browser frame with a Recharts area/line/bar chart. Data is computed each frame from Remotion.interpolate so the chart appears to draw left-to-right. Disable Recharts isAnimationActive — drive everything via the frame instead. Use for "stats / growth / metrics" beats.',
    references: [
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const base = [120, 140, 175, 168, 220, 260, 245, 310, 360, 380, 420, 480]
  const progress = Remotion.interpolate(f, [10, 90], [0, base.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const data = base.map((v, i) => ({ d: i + 1, v: i < progress ? v : null }))
  const labelT = Remotion.spring({ frame: f - 24, fps, config: { damping: 16, stiffness: 100 } })
  const labelOp = Remotion.interpolate(labelT, [0, 1], [0, 1])
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10'>
      <Remotion.MockFrame url={\`\${branding.productName.toLowerCase()}.app/analytics\`} tone='light'>
        <div className='p-6 flex flex-col gap-3 h-full'>
          <div className='flex items-center gap-2.5'>
            <Remotion.Icons.Zap size={14} color={branding.accentColor} />
            <span className='text-[11px] font-bold tracking-widest uppercase text-zinc-500'>Last 12 days</span>
            <span className='ml-auto' style={{ opacity: labelOp }}><Remotion.Pill tone='success' dot>+38%</Remotion.Pill></span>
          </div>
          <div className='text-3xl font-bold tabular-nums tracking-tight' style={{ opacity: labelOp, color: branding.accentColor }}>4,820 queries</div>
          <div className='flex-1 -mx-2'>
            <Remotion.Charts.ResponsiveContainer width='100%' height='100%'>
              <Remotion.Charts.AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>
                    <stop offset='0%' stopColor={branding.accentColor} stopOpacity={0.55} />
                    <stop offset='100%' stopColor={branding.accentColor} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <Remotion.Charts.Area type='monotone' dataKey='v' stroke={branding.accentColor} strokeWidth={2.5} fill='url(#g)' isAnimationActive={false} />
              </Remotion.Charts.AreaChart>
            </Remotion.Charts.ResponsiveContainer>
          </div>
        </div>
      </Remotion.MockFrame>
    </Remotion.AbsoluteFill>
  )
}`,
      // Variant: bar chart with values popping in left-to-right + the
      // tallest bar getting an accent halo. Different visual rhythm —
      // categorical comparison vs continuous growth.
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const cats = [
    { name: 'Mon', v: 240 }, { name: 'Tue', v: 380 }, { name: 'Wed', v: 320 },
    { name: 'Thu', v: 520 }, { name: 'Fri', v: 680 }, { name: 'Sat', v: 410 }, { name: 'Sun', v: 480 },
  ]
  const peakIdx = cats.reduce((m, c, i) => (c.v > cats[m].v ? i : m), 0)
  const headerOp = Remotion.interpolate(f, [0, 14], [0, 1], { extrapolateRight: 'clamp' })
  const sumEase = Remotion.interpolate(f, [10, 10 + fps * 1.4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const total = Math.round(cats.reduce((a, c) => a + c.v, 0) * sumEase)
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10'>
      <Remotion.MockFrame url={\`\${branding.productName.toLowerCase()}.app/dashboard\`} tone='light'>
        <div className='p-6 flex flex-col gap-3 h-full'>
          <div className='flex items-baseline gap-3' style={{ opacity: headerOp }}>
            <div className='text-[11px] font-bold tracking-widest uppercase text-zinc-500'>This week</div>
            <div className='ml-auto text-[12px] font-medium text-zinc-500'>peak <span style={{ color: branding.accentColor, fontWeight: 700 }}>{cats[peakIdx].name}</span></div>
          </div>
          <div className='text-[44px] font-black tracking-tight tabular-nums' style={{ color: branding.accentColor }}>{total.toLocaleString()}<span className='text-[16px] text-zinc-500 font-medium ml-2'>resolutions</span></div>
          <div className='flex-1 flex items-end gap-2 pt-2'>
            {cats.map((c, i) => {
              const t = Remotion.interpolate(f, [20 + i * 5, 20 + i * 5 + 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
              const h = (c.v / 700) * 220 * t
              const isPeak = i === peakIdx
              const pulse = isPeak ? 0.9 + 0.1 * Math.sin(f / 14) : 1
              return (
                <div key={i} className='flex-1 flex flex-col items-center gap-2'>
                  <div className='w-full rounded-t-md' style={{ height: \`\${h}px\`, background: isPeak ? branding.accentColor : \`\${branding.accentColor}55\`, boxShadow: isPeak ? \`0 0 24px \${branding.accentColor}88\` : 'none', opacity: pulse }} />
                  <span className='text-[10px] font-medium text-zinc-500'>{c.name}</span>
                </div>
              )
            })}
          </div>
        </div>
      </Remotion.MockFrame>
    </Remotion.AbsoluteFill>
  )
}`,
    ],
  },
  {
    id: 'cursor-click',
    isAbstract: false,
    description:
      'Browser frame with a POPULATED product surface — header bar with title and pill, an empty-state line, a CTA button. Cursor flies in from top-right and clicks the CTA at ~frame 70 with a ripple. NEVER an isolated button on an empty page. Maximum ONE Remotion.AnimatedCursor per scene; uses leftPct + topPct numbers (0-100), NOT a path array.',
    references: [
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const headerT = Remotion.spring({ frame: f, fps, config: { damping: 16, stiffness: 90 } })
  const headerOp = Remotion.interpolate(headerT, [0, 1], [0, 1])
  const btnT = Remotion.spring({ frame: f - 12, fps, config: { damping: 16, stiffness: 90 } })
  const btnOp = Remotion.interpolate(btnT, [0, 1], [0, 1])
  const btnScale = Remotion.interpolate(btnT, [0, 1], [0.96, 1])
  const curT = Remotion.spring({ frame: f - 28, fps, config: { damping: 16, stiffness: 70 } })
  const curL = Remotion.interpolate(curT, [0, 1], [82, 50])
  const curTp = Remotion.interpolate(curT, [0, 1], [12, 55])
  const click = f >= 70 && f < 78
  const ripple = Remotion.interpolate(f, [70, 92], [0, 70], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const rippleOp = Remotion.interpolate(f, [70, 92], [0.55, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const press = click ? 0.96 : 1
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10'>
      <Remotion.MockFrame url={\`\${branding.productName.toLowerCase()}.app/settings/tokens\`} tone='light'>
        <div className='h-full flex flex-col' style={{ opacity: headerOp }}>
          <header className='px-6 py-4 border-b border-zinc-200 flex items-center gap-3'>
            <Remotion.Icons.Lock size={16} color={branding.accentColor} />
            <span className='text-[14px] font-bold tracking-tight text-zinc-900'>API Tokens</span>
            <span className='ml-auto'><Remotion.Pill tone='muted'>0 active</Remotion.Pill></span>
          </header>
          <div className='flex-1 flex flex-col items-center justify-center gap-4 px-6'>
            <div className='w-12 h-12 rounded-2xl flex items-center justify-center' style={{ background: \`\${branding.accentColor}15\` }}>
              <Remotion.Icons.Plus size={22} color={branding.accentColor} />
            </div>
            <div className='text-center flex flex-col gap-1'>
              <div className='text-[15px] font-semibold text-zinc-900 tracking-tight'>No tokens yet</div>
              <div className='text-[13px] text-zinc-500'>Generate a token to authorize Claude.</div>
            </div>
            <button className='px-6 py-3 rounded-xl text-white text-[14px] font-bold' style={{ background: branding.accentColor, boxShadow: \`0 1px 2px rgba(0,0,0,0.06), 0 14px 32px -4px \${branding.accentColor}55\`, opacity: btnOp, transform: \`scale(\${btnScale * press})\` }}>Create token</button>
          </div>
        </div>
      </Remotion.MockFrame>
      <Remotion.AnimatedCursor leftPct={curL} topPct={curTp} ripple={click} rippleRadius={ripple} rippleOpacity={rippleOp} accentColor={branding.accentColor} />
    </Remotion.AbsoluteFill>
  )
}`,
      // Variant: cursor lands on a search input, types a query
      // character-by-character, then a result card highlights below.
      // Different action vocabulary — "search" not "click button".
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const headerOp = Remotion.interpolate(f, [0, 14], [0, 1], { extrapolateRight: 'clamp' })
  const curT = Remotion.spring({ frame: f - 14, fps, config: { damping: 16, stiffness: 70 } })
  const curL = Remotion.interpolate(curT, [0, 1], [82, 50])
  const curTp = Remotion.interpolate(curT, [0, 1], [12, 30])
  const query = 'how do I deploy?'
  const charsShown = Math.max(0, Math.floor(Remotion.interpolate(f, [40, 90], [0, query.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })))
  const resultOp = Remotion.interpolate(f, [95, 110], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const blink = (f % 30) < 15 ? 1 : 0
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10'>
      <Remotion.MockFrame url={\`\${branding.productName.toLowerCase()}.app\`} tone='light'>
        <div className='h-full flex flex-col p-6 gap-4' style={{ opacity: headerOp }}>
          <div className='rounded-2xl border border-zinc-200 px-4 py-3 flex items-center gap-3 bg-white'>
            <Remotion.Icons.Search size={16} color='#A1A1AA' />
            <span className='text-[15px] text-zinc-900'>{query.slice(0, charsShown)}<span className='inline-block w-[2px] h-[16px] ml-0.5 align-middle' style={{ background: branding.accentColor, opacity: blink }} /></span>
          </div>
          <div className='rounded-2xl p-4 border flex items-start gap-3' style={{ opacity: resultOp, background: \`\${branding.accentColor}08\`, borderColor: \`\${branding.accentColor}33\` }}>
            <div className='w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0' style={{ background: branding.accentColor }}>
              <Remotion.Icons.Rocket size={16} color='#FFFFFF' />
            </div>
            <div className='flex-1'>
              <div className='text-[13px] font-bold text-zinc-900 tracking-tight'>Deploy guide</div>
              <div className='text-[12px] text-zinc-600 leading-snug mt-0.5'>vercel deploy + env setup, 4 steps · 2 min read</div>
            </div>
            <Remotion.Pill tone='accent' accentColor={branding.accentColor}>top match</Remotion.Pill>
          </div>
        </div>
      </Remotion.MockFrame>
      <Remotion.AnimatedCursor leftPct={curL} topPct={curTp} ripple={false} rippleRadius={0} rippleOpacity={0} accentColor={branding.accentColor} />
    </Remotion.AbsoluteFill>
  )
}`,
    ],
  },
  {
    id: 'flow-diagram',
    isAbstract: true,
    description:
      'NO browser frame. Three connected nodes representing a 3-step process (e.g. "Your docs" → "AI reads" → "Better answers"). Animated arrows between them. Traveling dot along each connector — fps*1.6 cycle so the diagram stays alive the whole scene. Middle node is the accent-colored hero (gradient bg + glow shadow).',
    references: [
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const ease = (start) => Remotion.spring({ frame: f - start, fps, config: { damping: 16, stiffness: 90 } })
  const nodes = [
    { label: 'Your docs',   icon: 'Code',     delay: 0 },
    { label: 'AI reads',    icon: 'Cpu',      delay: 18, accent: true },
    { label: 'Better answers', icon: 'Check', delay: 36 },
  ]
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-12'>
      <div className='relative flex items-center gap-3'>
        {nodes.map((n, i) => {
          const t = ease(n.delay)
          const op = Remotion.interpolate(t, [0, 1], [0, 1])
          const sc = Remotion.interpolate(t, [0, 1], [0.85, 1])
          const Ico = Remotion.Icons[n.icon]
          const arrowT = i < nodes.length - 1 ? ease(n.delay + 8) : null
          const arrowOp = arrowT !== null ? Remotion.interpolate(arrowT, [0, 1], [0, 1]) : 0
          return (
            <React.Fragment key={i}>
              <div className={\`w-[160px] h-[160px] rounded-3xl flex flex-col items-center justify-center gap-3 \${n.accent ? '' : 'bg-white border border-zinc-200/70'}\`} style={{ opacity: op, transform: \`scale(\${sc})\`, boxShadow: n.accent ? \`0 1px 2px rgba(0,0,0,0.06), 0 24px 48px -8px \${branding.accentColor}55\` : '0 1px 2px rgba(0,0,0,0.04), 0 12px 32px -8px rgba(0,0,0,0.10)', background: n.accent ? \`linear-gradient(135deg, \${branding.accentColor}, \${branding.accentColor}CC)\` : undefined }}>
                <Ico size={36} color={n.accent ? '#FFFFFF' : branding.accentColor} />
                <div className={\`text-[14px] font-bold tracking-tight \${n.accent ? 'text-white' : 'text-zinc-900'}\`}>{n.label}</div>
              </div>
              {arrowT !== null && (
                <div className='relative flex items-center' style={{ opacity: arrowOp }}>
                  <div className='h-[2px] w-12 rounded' style={{ background: \`\${branding.accentColor}55\` }} />
                  <Remotion.Icons.ArrowRight size={20} color={branding.accentColor} />
                  <div className='absolute top-1/2 -mt-1 w-2 h-2 rounded-full' style={{ background: branding.accentColor, left: \`\${((f - n.delay - 8) / (fps * 1.6) % 1 + 1) % 1 * 80}%\`, opacity: arrowOp, boxShadow: \`0 0 12px \${branding.accentColor}\` }} />
                </div>
              )}
            </React.Fragment>
          )
        })}
      </div>
    </Remotion.AbsoluteFill>
  )
}`,
      // Variant: vertical converging flow — 3 inputs (doc, video,
      // markdown) feed into a central AI core which emits ONE output
      // (chat answer). Different layout shape (Y converging) + different
      // story (many-to-one transformation).
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const ease = (start) => Remotion.spring({ frame: f - start, fps, config: { damping: 16, stiffness: 90 } })
  const inputs = [
    { label: 'Recordings', icon: 'Video' },
    { label: 'Markdown',   icon: 'FileText' },
    { label: 'Screenshots', icon: 'Image' },
  ]
  const corePulse = 1 + 0.04 * Math.sin(f / 14)
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10'>
      <div className='flex items-center gap-10'>
        <div className='flex flex-col gap-3'>
          {inputs.map((n, i) => {
            const t = ease(i * 8)
            const op = Remotion.interpolate(t, [0, 1], [0, 1])
            const x = Remotion.interpolate(t, [0, 1], [-30, 0])
            const Ico = Remotion.Icons[n.icon]
            return (
              <div key={i} className='flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-white border border-zinc-200/70' style={{ opacity: op, transform: \`translateX(\${x}px)\`, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
                <Ico size={18} color={branding.accentColor} />
                <span className='text-[13px] font-semibold text-zinc-800'>{n.label}</span>
              </div>
            )
          })}
        </div>
        <div className='relative w-20 h-32'>
          {[0,1,2].map(i => {
            const dotT = (f - 30 - i * 8) / (fps * 1.4)
            const t = ((dotT % 1) + 1) % 1
            const op = dotT > 0 ? 1 : 0
            const yPos = (i - 1) * 38 + 64 - t * ((i - 1) * 38)
            return <div key={i} className='absolute w-2 h-2 rounded-full' style={{ left: \`\${t * 100}%\`, top: yPos, background: branding.accentColor, opacity: op, boxShadow: \`0 0 12px \${branding.accentColor}\` }} />
          })}
        </div>
        <div className='w-[140px] h-[140px] rounded-3xl flex items-center justify-center relative' style={{ background: \`linear-gradient(135deg, \${branding.accentColor}, \${branding.accentColor}AA)\`, transform: \`scale(\${corePulse})\`, boxShadow: \`0 24px 60px -8px \${branding.accentColor}66\` }}>
          <Remotion.Icons.Cpu size={56} color='#FFFFFF' />
        </div>
        <div className='flex items-center gap-2'>
          <Remotion.Icons.ArrowRight size={20} color={branding.accentColor} />
          <div className='px-4 py-3 rounded-2xl rounded-tl-md' style={{ opacity: Remotion.interpolate(f, [80, 96], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }), background: branding.accentColor }}>
            <div className='text-[12px] font-bold text-white tracking-tight'>Instant answer</div>
          </div>
        </div>
      </div>
    </Remotion.AbsoluteFill>
  )
}`,
    ],
  },
  {
    id: 'logo-hero',
    isAbstract: true,
    description:
      "NO browser frame. The PROJECT'S real logo (branding.logoUrl via Remotion.Img at 140-180px) + small uppercase product name + tagline below. NEVER fabricate a fake brand icon (lucide pictogram in a rounded square — reads as a stock placeholder). If logoUrl is null, fall back to clean overlapping geometric shapes with a gradient.",
    references: [
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const markT = Remotion.spring({ frame: f, fps, config: { damping: 14, stiffness: 90 } })
  const textT = Remotion.spring({ frame: f - 14, fps, config: { damping: 16, stiffness: 90 } })
  const markOp = Remotion.interpolate(markT, [0, 1], [0, 1])
  const markSc = Remotion.interpolate(markT, [0, 1], [0.7, 1])
  const textOp = Remotion.interpolate(textT, [0, 1], [0, 1])
  const textY = Remotion.interpolate(textT, [0, 1], [24, 0])
  return (
    <Remotion.AbsoluteFill className='flex flex-col items-center justify-center gap-8'>
      <div style={{ opacity: markOp, transform: \`scale(\${markSc})\` }}>
        {branding.logoUrl ? (
          <Remotion.Img src={branding.logoUrl} style={{ height: 160, width: 'auto', maxWidth: 360, objectFit: 'contain' }} />
        ) : (
          <div className='relative w-[160px] h-[160px]'>
            <div className='absolute inset-0 rounded-[36px]' style={{ background: \`linear-gradient(135deg, \${branding.accentColor}, \${branding.accentColor}AA)\` }} />
            <div className='absolute -bottom-6 -right-6 w-[110px] h-[110px] rounded-full' style={{ background: \`\${branding.accentColor}33\`, mixBlendMode: 'multiply' }} />
            <div className='absolute top-4 left-4 w-12 h-12 rounded-2xl bg-white/15' />
          </div>
        )}
      </div>
      <div className='flex flex-col items-center gap-3' style={{ opacity: textOp, transform: \`translateY(\${textY}px)\` }}>
        <div className='text-[11px] font-bold tracking-widest uppercase text-zinc-500'>{branding.productName}</div>
        <div className='text-[44px] font-bold tracking-tight text-zinc-900'>Smarter answers, instantly.</div>
      </div>
    </Remotion.AbsoluteFill>
  )
}`,
      // Variant: animated logo reveal with shimmer wipe + the tagline
      // appears as a shorter en-dash counterpoint to the right.
      // Different layout (horizontal) + different motion (shimmer).
      `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const wipeX = Remotion.interpolate(f, [10, 50], [-120, 220], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const taglineOp = Remotion.interpolate(f, [40, 56], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const lineW = Remotion.interpolate(f, [38, 60], [0, 80], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center'>
      <div className='flex items-center gap-8'>
        <div className='relative overflow-hidden rounded-3xl' style={{ height: 140, width: 140 }}>
          {branding.logoUrl ? (
            <Remotion.Img src={branding.logoUrl} style={{ height: 140, width: 140, objectFit: 'contain' }} />
          ) : (
            <div className='absolute inset-0' style={{ background: \`linear-gradient(135deg, \${branding.accentColor}, \${branding.accentColor}AA)\` }} />
          )}
          <div className='absolute inset-y-0 w-16 pointer-events-none' style={{ left: \`\${wipeX}%\`, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)', mixBlendMode: 'screen' }} />
        </div>
        <div className='h-[2px] rounded-full' style={{ width: \`\${lineW}px\`, background: branding.accentColor, opacity: 0.6 }} />
        <div className='flex flex-col gap-2' style={{ opacity: taglineOp }}>
          <div className='text-[11px] font-bold tracking-[0.2em] uppercase' style={{ color: branding.accentColor }}>{branding.productName}</div>
          <div className='text-[40px] font-black tracking-tight leading-[1.05] text-zinc-900 max-w-[400px]'>Docs that ship<br />themselves.</div>
        </div>
      </div>
    </Remotion.AbsoluteFill>
  )
}`,
    ],
  },
] as const

/** A single TSX example in the cross-mode design library shown to the
 *  designer. The point of having a flat library (rather than locking
 *  each scene to its mode's references) is that the designer browses
 *  many products' visual treatments and INVENTS rather than copies. */
interface DesignInspiration {
  /** Loose tag for logs / debugging — e.g. "hero-stat-counter",
   *  "bento-activity-feed". Not shown to the designer. */
  tag: string
  /** Which mode this inspiration is structurally aligned with —
   *  used to bias the sample so a hero-stat scene at least sees
   *  one hero-stat-shaped example. */
  mode: string
  /** TSX source of the example. */
  tsx: string
}

/** Flat library of all TSX inspirations across all modes. Computed
 *  from SCENE_MODES.references so adding a variant in SCENE_MODES
 *  automatically adds it to the library — single source of truth. */
const DESIGN_INSPIRATIONS: DesignInspiration[] = SCENE_MODES.flatMap((mode) =>
  mode.references.map((tsx, i) => ({
    tag: `${mode.id}-v${i + 1}`,
    mode: mode.id,
    tsx,
  })),
)

/** Synthetic mode used when the architect outputs visualMode === 'custom'.
 *  No structural template — the designer composes freely from the brief
 *  + the cross-mode design library. Used as the escape hatch when none
 *  of the 8 catalog modes structurally fit the scene's idea (e.g.
 *  "split-screen before/after", "isometric stack", "kanban motion"). */
const CUSTOM_MODE: SceneMode = {
  id: 'custom',
  isAbstract: false,
  description:
    "No structural template — the architect determined that none of the standard modes structurally fit this scene's idea, so you have full creative latitude. Compose freely from the design library and the brief. The brief is the ENTIRE spec; if it's vague, default to a clean composition that visually illustrates the headline + voiceover.",
  references: [],
}

/** Pick N inspirations to show the designer. Bias: 1 mode-matching
 *  (so a hero-stat scene sees at least one hero-stat-shaped example,
 *  preserving structural quality floor) + N-1 random from anywhere
 *  (so the designer always sees cross-product variety, breaking the
 *  "every hero-stat looks identical" failure mode). */
function pickInspirations(modeId: string, count: number): DesignInspiration[] {
  const shuffle = <T,>(arr: readonly T[]): T[] => [...arr].sort(() => Math.random() - 0.5)
  const matching = DESIGN_INSPIRATIONS.filter((i) => i.mode === modeId)
  const others = DESIGN_INSPIRATIONS.filter((i) => i.mode !== modeId)
  const picked = [
    ...shuffle(matching).slice(0, 1),
    ...shuffle(others).slice(0, Math.max(0, count - 1)),
  ]
  // Top up with whatever's left (matching pool was empty, etc.).
  const remaining = DESIGN_INSPIRATIONS.filter((i) => !picked.find((p) => p.tag === i.tag))
  while (picked.length < count && remaining.length > 0) {
    picked.push(remaining.shift()!)
  }
  return shuffle(picked.slice(0, count))
}

/** Pick N distinct scene modes. With 2-4 scenes (the typical range) we
 *  force at least one UI mode + at least one abstract mode so the
 *  video isn't all "look at the dashboard" or all "magazine cover". */
function pickSceneModes(count: number): SceneMode[] {
  const shuffle = <T,>(arr: readonly T[]): T[] => [...arr].sort(() => Math.random() - 0.5)
  if (count <= 0) return []
  if (count === 1) return [shuffle(SCENE_MODES)[0]!]
  const ui = shuffle(SCENE_MODES.filter((m) => !m.isAbstract))
  const abstract = shuffle(SCENE_MODES.filter((m) => m.isAbstract))
  const targetUi = Math.min(ui.length, Math.max(1, Math.floor(count / 2)))
  const targetAbstract = Math.min(abstract.length, Math.max(1, count - targetUi))
  const picked = [...ui.slice(0, targetUi), ...abstract.slice(0, targetAbstract)]
  // Top up if the floor/ceil math under-picked.
  const remaining = SCENE_MODES.filter((m) => !picked.find((p) => p.id === m.id))
  while (picked.length < count && remaining.length > 0) {
    picked.push(remaining.shift()!)
  }
  return shuffle(picked).slice(0, count)
}

/** Hard rules every per-scene mockCode call must enforce. Extracted as
 *  a constant so the surface doesn't drift between calls. The 🚨
 *  callouts are deliberately at the TOP — past renders failed because
 *  these rules were buried in a 500-line monolithic prompt. */
const MOCK_CODE_HARD_RULES = `🚨 CRITICAL — these have FAILED in past renders, get them right or the scene falls back to a flat color:

1. **Function name MUST be exactly \`MockScene\`.** Not Scene, not Hook, not anything else. Signature:
   \`\`\`tsx
   function MockScene({ branding }) { ... }
   \`\`\`
   The runtime evaluates your code and looks up \`MockScene\` by name. Wrong name = scene doesn't render.

2. **Outer \`<Remotion.AbsoluteFill>\` MUST be transparent.** Use ONLY:
   \`<Remotion.AbsoluteFill className='flex items-center justify-center p-10'>\`
   - NO \`style={{ background: ... }}\` of any kind on the outer
   - NO Tailwind background utility (\`bg-white\`, \`bg-slate-900\`, \`bg-zinc-100\`, \`bg-gradient-to-br\` are ALL forbidden on the outer)
   - NO \`overflow-hidden\` on the outer
   The video canvas is already painted \`branding.bgColor\`. A different background on the outer creates a visible colored panel that doesn't match the rest of the video. If you want depth, layer it INSIDE a card / MockFrame, NEVER on the outer.

3. **NO imports, NO require, NO fetch, NO XMLHttpRequest, NO eval, NO new Function.** \`React\`, \`Remotion\`, and \`branding\` are passed as parameters; everything you need lives on those.

4. **NEVER write inline \`<svg>\` tags.** Two alternatives, depending on what you need:
   - **Icons** → \`Remotion.Icons.X\` (any lucide-react name — Cpu, Workflow, Database, BookOpen, Rocket, Zap, TrendingUp, etc; \`Sparkles\` is BANNED). The full ~1500-icon lucide catalog is exposed via a Proxy.
   - **Connecting lines, arrows, branches between nodes (flow-diagram, etc.)** → absolute-positioned \`<div>\` elements with explicit \`width\` + \`height\` (1-3px on the short axis) + \`background\` + \`transform: rotate(<angle>deg)\` for diagonal lines. Compose multiple lines to build branches or curves. Example: a line from node A to node B at 45° is a \`<div className='absolute' style={{ width: 120, height: 2, background: branding.accentColor, transform: 'rotate(45deg)', top: ..., left: ... }} />\`.

   Inline SVG breaks frequently (off-size, wrong stroke, no animation hooks) and is banned full stop.

5. **NEVER use \`<Remotion.AccentGlow>\`.** Deprecated — the halo bleeds onto the canvas and reads as a render glitch.

6. **\`<Remotion.AnimatedCursor>\` takes \`leftPct\` + \`topPct\` numbers (0-100), NOT a path array.** Maximum ONE per scene, and ONLY when the MockFrame interior shows a populated UI (header + empty-state + CTA), never an isolated button.

7. **Branding fields available:** \`productName\`, \`accentColor\`, \`bgColor\`, \`textColor\`, \`fontFamily\`, \`logoUrl\`. Nothing else exists on \`branding\`.

8. **Layout stability — entries NEVER displace siblings.** Reserve the full layout from frame 0; animate ONLY \`opacity\` and \`transform\` (those don't affect layout). Never animate \`width\` / \`height\` / \`padding\` / \`margin\`. Never use conditional \`{cond && <div>}\` for elements that mount mid-scene. Pre-allocate slots; cross-fade content within them.

9. **Tailwind className for static styling, inline \`style={{}}\` only for animated values.** Twind is installed; every Tailwind utility works at runtime.

10. **Code length: HARD CAP 9000 characters.** The compiler rejects anything longer.`

const MOCK_HELPERS_REFERENCE = `Available React: \`React.useMemo\`, \`React.Fragment\`. Don't use \`React.useEffect\` — frames re-render fresh.

Available Remotion namespace (use as \`Remotion.foo\`):
- \`Remotion.useCurrentFrame()\` → number, current frame within THIS scene's sub-timeline (frame 0 is the start of THIS scene, NOT the whole video).
- \`Remotion.useVideoConfig()\` → \`{ fps, durationInFrames, width, height }\`.
- \`Remotion.interpolate(input, [in1, in2, …], [out1, out2, …], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })\`
- \`Remotion.spring({ frame, fps, config: { damping, stiffness, mass } })\`
- \`Remotion.AbsoluteFill\`, \`Remotion.Img\`

**Pre-built helpers (USE THESE):**
- \`<Remotion.MockFrame url='app.example.com/path' tone='light'>{children}</Remotion.MockFrame>\` — designed browser-window chrome (macOS traffic lights + URL bar). Use ONLY \`tone='light'\`. NEVER nest two MockFrames; max ONE per scene.

  ⚠ **MockFrame inherits its size from its parent — never let it collapse to intrinsic content size.** Always wrap it in a parent div with an EXPLICIT width, and add an explicit height when the children need pixel-area to render into. Pick the dimensions based on the scene:
  - **Width**: the visual canvas is 920×580. Pick a parent width that leaves ~20-100px of breathing room and fits the scene's content density. A dense bento with three cards needs more width than a single chat bubble.
  - **Height**: usually leave content-driven. Set explicit height ONLY when children include \`flex-1\`, a \`<Remotion.Charts.ResponsiveContainer>\`, or any element that itself needs a fixed pixel area to fill — those collapse to 0px without a sized ancestor and you get a chart scene that renders as a tiny strip.
  - **Perspective tilt**: \`transform: perspective(...) rotateY(...)\` does NOT constrain layout size; you still need width / height on the wrapper.
  Past renders had chart scenes render at ~200px wide because the wrapper had no width constraint and the inner \`ResponsiveContainer\` couldn't compute a height — both fixes belong on the wrapper, not on the chart itself.
- \`<Remotion.Pill tone='success' | 'warning' | 'danger' | 'accent' | 'muted' dot accentColor={branding.accentColor}>connected</Remotion.Pill>\`
- \`<Remotion.AnimatedCursor leftPct={50} topPct={55} ripple={click} rippleRadius={r} rippleOpacity={ro} accentColor={branding.accentColor} />\`
- \`<Remotion.Icons.Cpu size={14} color='currentColor' />\` — accepts ANY lucide-react icon name, pre-wrapped at strokeWidth=1.5 (Linear/Vercel weight). Don't override stroke. Aliases: Message → MessageSquare, Volume → Volume2, BarChart → BarChart2.
- \`Remotion.Charts\` — recharts subset: \`ResponsiveContainer\`, \`LineChart\`, \`Line\`, \`AreaChart\`, \`Area\`, \`BarChart\`, \`Bar\`, \`PieChart\`, \`Pie\`, \`Cell\`, \`XAxis\`, \`YAxis\`, \`CartesianGrid\`, \`Tooltip\`. Wrap in \`<Remotion.Charts.ResponsiveContainer width='100%' height='100%'>\` inside a fixed-size parent. Set \`isAnimationActive={false}\` and drive data via Remotion.interpolate.

Canvas is **920 wide × 580 tall** (the visual half of the scene; the headline sits in the OTHER half). Position relative to this — NOT 1920×1080. Prefer flex centering over absolute pixel coordinates.`

/** Sustained-motion + animation idioms section. Uses <DURATION> /
 *  <FRAMES> placeholders that buildSceneMockPrompt fills in per scene. */
const ANIMATION_IDIOMS = `**SUSTAINED MOTION — non-negotiable.** This scene runs <DURATION>s (<FRAMES> frames at 30fps). Entry animations alone are not enough — past renders had a dead-static canvas after the first 1-2 seconds and the user flagged "bancale". Layer in CONTINUOUS motion that runs the WHOLE scene. Pick at LEAST one:

- **Counter ticking up live** (hero-stat / bento): a number animates from 0 to its target across 1.5s and then KEEPS ticking by ±1 every ~30 frames so the dashboard feels live.
- **Traveling dot along a connector** (flow-diagram): \`const t = (f % (fps * 1.6)) / (fps * 1.6)\` then \`left: \\\`\${t * 100}%\\\`\`.
- **AI typing dots** (chat): three pulsing dots BEFORE the AI reply, each dot's opacity cycles 0.3 → 1 → 0.3 with a 6-frame stagger.
- **Cursor blink** (input/text): \`opacity: (f % 30) < 15 ? 1 : 0\`.
- **Subtle accent pulse** (focal element): \`scale: 1 + 0.02 * Math.sin(f / 18)\` or pulsing boxShadow blur.
- **Live-indicator dot** on a "connected" pill: \`opacity: 0.6 + 0.4 * Math.sin(f / 12)\`.

Do NOT cram all entry animations into the first 30 frames and then leave the canvas frozen.

**SMOOTH MOTION — avoid the choppy / saccadée failure mode.** Past renders looked jerky because of:
1. **Too-tight interpolate windows.** \`interpolate(f, [0, 4], [0, 1])\` ramps in 4 frames = 0.13s = a hard cut perceived as a snap. Use **at least 12 frames** for any opacity / position change (~0.4s). Springs help — they ease in and out naturally.
2. **Stepped opacity flips.** \`opacity: f > 60 ? 1 : 0\` is a binary cut. Use \`Remotion.interpolate(f, [55, 70], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })\` instead — same intent, smooth.
3. **Stacking 5+ entry animations all at the same start frame.** They visually compete and each one is half-finished when the next starts. Stagger entries every 6-12 frames so the eye lands on one element at a time.
4. **Spring with low damping bouncing forever.** Use \`damping: 14-18\` (most cases) or \`16-20\` (settled / serious tone). \`damping: 8\` will visibly oscillate.
5. **Sin-based motion at the wrong frequency.** \`Math.sin(f / 6)\` cycles every ~37 frames = 1.2s = visibly fast / nervous. Use \`Math.sin(f / 14-22)\` for ambient pulses (~3-5s cycles), \`Math.sin(f / 30+)\` for slow drifts.
6. **Stepped patterns (blink, pulse) on big elements.** \`(f % 30) < 15 ? 1 : 0\` is a hard 50/50 strobe — fine on a tiny cursor or live-indicator dot, distracting on anything bigger. For a ~30-frame visible cycle on a card, prefer the smooth sin form: \`opacity: 0.6 + 0.4 * Math.sin(f / 14)\`.

Animation idioms (steal these — all SMOOTH by construction):
- Stagger fade + slide for entries: \`const op = Remotion.interpolate(frame, [start, start+12], [0, 1], { extrapolateRight: 'clamp' })\` — 12-frame fade is the floor.
- Spring entries: \`const t = Remotion.spring({ frame: frame - delay, fps, config: { damping: 16, stiffness: 90 } })\` then derive opacity / scale / translateY from \`t\`. Springs naturally ease.
- Type-on text: \`const charsShown = Math.floor(Remotion.interpolate(frame, [0, 60], [0, fullText.length], { extrapolateRight: 'clamp' }))\` then \`fullText.slice(0, charsShown)\`.
- Smooth pulse: \`opacity: 0.6 + 0.4 * Math.sin(f / 14)\` (ambient cycle ~3s).
- Smooth scale-breathe: \`scale: 1 + 0.02 * Math.sin(f / 18)\`.
- Hard step (use ONLY on small accent elements like a cursor caret or a tiny live dot): \`(f % 30) < 15 ? 1 : 0\`.

**Type at scale.** Headlines text-[32-44px] font-bold tracking-tight. Big numbers text-[64-100px] tabular-nums tracking-tight. Body text-[15-18px]. Labels text-[11px] font-bold tracking-widest uppercase.

**Typography: Geist by default — NEVER set fontFamily inline.** The bundle ships Geist Sans as the default for every Tailwind \`text-*\` className. DO NOT override with \`fontFamily: 'ui-monospace, ...'\`. Use \`font-mono\` className ONLY for actual code, URLs, or terminal lines. Never for prose, chat bubbles, or headings.

**Icons: never \`Sparkles\`** (banned cliché). Use \`Cpu\` / \`Workflow\` / \`Atom\` / \`CircuitBoard\` / \`Layers\` / \`Boxes\` for AI moments. \`BarChart3\` / \`TrendingUp\` / \`LineChart\` for analytics.

# 2026 modern aesthetic — restraint + texture

This is the section that separates "branded SaaS template" from "modern marketing video". The references above show ONE acceptable shape per mode; the visual TREATMENT below is what makes them feel current. Apply it on top of the assigned mode.

## RESTRAINT — accent is a punch, not a wash

Past renders had \`accentColor\` on the bg gradient + the border + the number + the dot + the button + the icon — every element competing for attention, the result reads "branded" not "designed". Modern marketing video aesthetics (Linear 2026, Vercel, Stripe, Arc, Cursor, Raycast) use accent SPARINGLY: **1, maximum 2 elements per scene get full accent saturation; everything else is neutral**.

Concrete rules:
- **Maximum 2 accent-colored elements per scene.** Pick the focal element (the hero number, the CTA button, the middle node of a flow, the user chat bubble) — that gets full \`branding.accentColor\`. One small supporting hint (a tiny dot indicator, a thin accent line under a number, an icon) can also use accent. Everything else: zinc / white / black.
- **Outer cards / containers: NEUTRAL.** Use \`bg-white\` or \`bg-zinc-50\`, \`border border-zinc-200/80\`. NOT accent-tinted backgrounds (\`linear-gradient(..., \${accent}15, ...)\` is banned on container cards — only the SINGLE focal card may have an accent tint, and even then prefer \`\${accent}08\` not \`\${accent}15\`).
- **Borders: zinc, not accent.** \`border-zinc-200/70\` or \`border-zinc-100\`. Reserve accent borders for the ONE focal card.
- **Glows: subtle.** \`boxShadow: 0 8px 32px \${accent}22\` is the upper bound. NOT \`\${accent}55\` / \`\${accent}77\`. Past renders had glows so heavy they bled into adjacent cards.
- **Secondary text: zinc-600/500 not accent.** Eyebrow labels \`text-zinc-500\`, body \`text-zinc-700\`, supporting captions \`text-zinc-500\`. Only headline-level focal text gets accent (and only if it's the ONE focal element).
- **Pills / status badges:** prefer \`Remotion.Pill tone='success'\` / \`'muted'\` (zinc-toned). Reserve \`tone='accent'\` for ONE pill per scene.

Mental check before shipping: count the accent-colored elements in your scene. If it's > 2, strip the supporting ones to zinc.

## TEXTURE + DEPTH — what makes 2026 feel modern

Modern compositions feel layered without being noisy. Specific moves to lean on:

- **Subtle dot grid backdrop** on cards (or behind hero stats): a low-opacity radial dot pattern via \`background: radial-gradient(circle, #18181b08 1px, transparent 1px); backgroundSize: 24px 24px\`. Almost invisible but adds dimension. Use on the inside of large cards.
- **Glass / frosted highlights:** floating element on top of layered cards with \`backdrop-filter: blur(12px); background: rgba(255,255,255,0.6); border: 1px solid rgba(255,255,255,0.7)\`. ONE per scene max. Reads premium. **Never put text directly on / over a backdrop-filter element** — Chromium rasterizes the blurred layer and the text on top inherits the same compositing path, reading as "slightly hazy". Glass goes on a *background* surface, not under copy.
- **Conic / multi-stop gradients on the focal element only:** \`background: conic-gradient(from 220deg at 50% 50%, \${accent}, #18181b 60%, \${accent})\` — used as a 1px gradient border on a single hero card via the \`padding: 1px; border-radius: 16px\` trick (place a white card inside).
- **Inner shadow on big numbers:** \`textShadow: 0 1px 0 rgba(0,0,0,0.06)\` (not accent glow). Feels carved-in, premium.
- **Layered translucent surfaces:** card on top of card with \`bg-white/70 backdrop-blur-sm\`. The lower layer shows through subtly.
- **Asymmetric balance:** off-center hero (focal element at 35-45% rather than dead center). One side denser, other side breathes.
- **3D transforms (perspective + rotate) — use sparingly on text-heavy scenes.** The bento mode's tilt looks magazine-grade, but Chromium rasterizes 3D-transformed layers to a texture before projecting, which softens fine type. Keep tilts on bento (where the tradeoff is worth it for the layered-card aesthetic) but AVOID them on hero-stat / chart / chat where the focal element is text or thin chart strokes — those modes look much sharper with no perspective.
- **Mixed type weights with extreme contrast:** tiny eyebrow \`text-[10px] font-bold tracking-[0.2em] uppercase text-zinc-500\` paired with massive hero \`text-[120px] font-black tracking-tighter\`. The size jump is what reads as "magazine cover".
- **Lower contrast palette:** zinc-700 for body (not zinc-900). zinc-100 for secondary surfaces (not pure white). zinc-200 for borders. Only the focal element pops in zinc-900 / accent.
- **Generous whitespace:** \`p-8\` to \`p-12\` on outer cards, \`gap-5\` to \`gap-8\` between elements. Space says "designed", crammed says "form".
- **Soft thin shadows, NOT layered drops:** \`shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px -4px rgba(0,0,0,0.06)\`. Not the 2010-era \`shadow-2xl\` triple-stack with accent halos.
- **Number / unit hierarchy:** \`92\` huge in zinc-900, \`%\` smaller in zinc-400. Or \`240\` huge with \`ms\` tiny in zinc-500 next to it. Makes data feel typeset.
- **Single bright moment:** ONE element does something striking (a counter ticking + glow, a chart line drawing in, a pill flashing) — and the rest of the scene is calm support. Don't make 4 elements all "do something".

Anti-pattern reference: 2018 SaaS dashboard mockup energy = pastel gradients on every card, accent borders on every card, drop shadows everywhere, "vibrant" everywhere, equal visual weight on every element. **You're not making a 2018 dashboard.** You're making a 2026 marketing video. Restraint > maximalism.`

interface BuildSceneMockPromptArgs {
  scene: { headline: string; voiceover: string; subhead?: string; durationSeconds: number }
  mode: SceneMode
  productName: string
  /** Pre-fab style seed direction. Steers the visual language
   *  (editorial, high-contrast, etc.) WITHOUT overriding the assigned
   *  mode. Empty string when no seed picked. */
  styleSeed: string
  /** Architect-written brief naming exact elements / numbers / motion
   *  for THIS scene. Empty string when the architect didn't provide
   *  one (older manifest, model dropped the field) — designer falls
   *  back to inventing from headline + voiceover. */
  visualBrief: string
}

function buildSceneMockPrompt(args: BuildSceneMockPromptArgs): string {
  const { scene, mode, productName, styleSeed, visualBrief } = args
  const frameCount = Math.round(scene.durationSeconds * 30)
  const idioms = ANIMATION_IDIOMS
    .replace('<DURATION>', String(scene.durationSeconds))
    .replace('<FRAMES>', String(frameCount))
  const styleSeedBlock = styleSeed
    ? `\n## Style direction for this video\n\n${styleSeed}\n\nThis is a vibe nudge, not a constraint — the brief is still the spec.\n`
    : ''
  // The brief is THE source of truth for what's on screen. When the
  // architect provided one, point the designer at it as the primary
  // spec. When missing, fall back to inferring from headline +
  // voiceover (legacy / failure-mode path).
  const briefBlock = visualBrief.trim()
    ? `## Architect's visual brief (THIS is what you build)

${visualBrief.trim()}

The headline and voiceover above are context — the brief is the spec. Implement EVERY concrete element the brief names (specific numbers, exact text, the focal element, the motion idea). Don't invent unrelated content; don't drop elements the brief specified.`
    : `## What to put on screen

The animation must visually illustrate what the headline + voice-over are SAYING. If the voiceover is "your docs answer for you", show docs flowing into an AI module flowing into a chat reply — don't render lorem-ipsum unrelated to the scene.`

  // Cross-product design library: 4 examples drawn from across all
  // modes (1 mode-matching + 3 random). The point is that the
  // designer browses a DIVERSE vocabulary instead of cloning one
  // template. Different inspirations on every call → different look
  // across videos.
  const inspirations = pickInspirations(mode.id, 4)
  const inspirationsBlock = inspirations
    .map(
      (insp, i) => `### Inspiration ${i + 1} (${insp.tag})

\`\`\`tsx
${insp.tsx}
\`\`\``,
    )
    .join('\n\n')

  return `You are a DESIGNER agent writing the TSX for ONE scene of a marketing video. An ARCHITECT agent wrote the script + a per-scene visual brief; your job is to turn that brief into a Remotion-compatible MockScene component. Your output is the value of a single \`mockCode\` field — raw TSX that defines a function named \`MockScene\` taking \`{ branding }\` as its only prop.

This is a SANDBOX: the code runs inside a \`new Function(...)\` call with React + Remotion + branding bound. Imports, network access, and DOM mutation are forbidden.

## The scene you're animating

- **Headline (on-screen text):** "${scene.headline}"
${scene.subhead ? `- **Subhead:** "${scene.subhead}"\n` : ''}- **Voice-over (narration playing alongside):** "${scene.voiceover}"
- **Duration:** ${scene.durationSeconds}s (${frameCount} frames at 30fps)
- **Product:** ${productName}

${briefBlock}

## Structural directive: ${mode.id}

${mode.description}

This is the SHAPE the architect picked for this scene. Respect the structural rule (frame vs no-frame, vertical vs horizontal, bento vs hero) — but design the contents fresh.

## Design library — inspirations from other products

These are 4 TSX examples drawn from across different marketing-video aesthetics (analytics dashboards, hero counters, AI chat surfaces, deploy flows, search interfaces, brand opens). They are sampled randomly per call, so what you see here is not what other designers see — every video gets a different mix.

**These are NOT templates to copy. They are vocabulary to remix.** Steal a layout idea from one, a motion idiom from another, a type treatment from a third, and compose YOUR scene with the brief as the spec. A designer that ships a near-copy of any single inspiration is failing the brief — push further, mix elements, invent the combination that hasn't been done before.

${inspirationsBlock}
${styleSeedBlock}
## Hard rules — non-negotiable

${MOCK_CODE_HARD_RULES}

## Helpers + canvas

${MOCK_HELPERS_REFERENCE}

## Sustained motion + animation idioms

${idioms}

## Output

Return ONLY the raw TSX — no markdown fences, no explanation, no surrounding prose. Your output is fed directly to esbuild. The first character of your response should be \`f\` (start of \`function MockScene\`) or \`c\` (start of \`const MockScene =\`).`
}

async function generateSceneMockCode(args: BuildSceneMockPromptArgs): Promise<string> {
  const userPrompt = buildSceneMockPrompt(args)
  // Sonnet 4.6 has visibly stronger TSX + React composition than
  // Gemini Pro — bento layouts, perspective tilts, type hierarchy land
  // closer to the references. Per-scene calls run in parallel so the
  // wall-clock penalty caps at max(scenes), not sum. No model fallback:
  // on Sonnet error the calling pipeline routes through repairMockCode
  // (also Sonnet) and then `applyDeterministicFallback` if that fails.
  const MAX_OUT = 16_000
  const result = await generateSonnetText({
    userPrompt,
    maxTokens: MAX_OUT,
    temperature: 0.7,
  })
  let code = result.text.trim()

  if (code.startsWith('```')) {
    code = code.replace(/^```(?:tsx|jsx|ts|js)?\s*\n/, '').replace(/\n```\s*$/, '').trim()
  }
  if (code.length === 0) {
    throw new Error(`generateSceneMockCode/${args.mode.id}: Sonnet returned empty text`)
  }
  return code
}

// =============================================================================
// Stage 1: Skeleton generation (script structure only — no mockCode)
// =============================================================================

/**
 * Public wrapper around `generateSceneMockCode` for callers OUTSIDE the
 * fresh-generation orchestrator (specifically the edit/refine path in
 * marketing-video.service). Resolves mode + style seed from string
 * labels (which is what's persisted on the manifest) and falls back
 * sensibly when those labels are missing or unknown.
 *
 * Used by the AI-edit path: after the architect rewrites the script's
 * visualBrief / visualMode, we regenerate mockCode for the changed
 * scenes via this helper rather than asking the editor LLM to write
 * 4 mockCodes in one monolithic call (which dropped 3/4 in practice).
 */
export async function regenerateSceneMockCode(args: {
  scene: {
    headline: string
    voiceover: string
    subhead?: string
    durationSeconds: number
    visualMode?: string
    visualBrief?: string
  }
  productName: string
  /** Style-seed label from the existing manifest (e.g. "editorial").
   *  When missing or unknown, the helper picks a random seed so the
   *  designer still has a vibe to lean on. */
  styleSeedLabel?: string
}): Promise<string> {
  const modeId = args.scene.visualMode
  let mode: SceneMode
  if (modeId === 'custom') {
    mode = CUSTOM_MODE
  } else {
    const found = modeId ? SCENE_MODES.find((m) => m.id === modeId) : undefined
    mode = found ?? pickSceneModes(1)[0]!
  }
  const seed = args.styleSeedLabel
    ? STYLE_SEEDS.find((s) => s.label === args.styleSeedLabel) ?? pickStyleSeed()
    : pickStyleSeed()
  return generateSceneMockCode({
    scene: {
      headline: args.scene.headline,
      voiceover: args.scene.voiceover,
      subhead: args.scene.subhead,
      durationSeconds: args.scene.durationSeconds,
    },
    mode,
    productName: args.productName,
    styleSeed: seed.brief,
    visualBrief: args.scene.visualBrief ?? '',
  })
}

function buildSkeletonPrompt(input: GenerateMarketingScriptInput): string {
  const captionList = input.screenshotCaptions
    .map((c, i) => `  [${i}] ${c}`)
    .join('\n')

  const briefBlock = input.userPrompt?.trim()
    ? `\n## Creative brief from the user (HIGHEST PRIORITY for framing — but never overrides the documentation as factual ground truth)\n\n${input.userPrompt.trim()}\n\nRespect this brief: pick the angle, audience, tone shift, and which capabilities to emphasize from it. If the brief asks for something the documentation doesn't support, stay grounded in the docs and pivot the framing — don't invent features to satisfy the brief.\n`
    : ''

  // Catalog of aesthetic directions the architect picks from. Each
  // label maps to a one-line brief that the designers receive
  // alongside the per-scene visualBrief. Architect-picked (instead of
  // orchestrator-random) so the seed is coherent with the brand /
  // audience / creative brief.
  const styleSeedCatalog = STYLE_SEEDS
    .map((s) => `- **${s.label}**: ${s.brief}`)
    .join('\n')
  const styleSeedBlock = input.visualMode === 'mocks'
    ? `\n## Whole-video aesthetic — pick a style seed

Pick ONE label from the catalog below as the \`styleSeed\` field. This sets the visual vocabulary the designers lean on across all scenes. Pick based on the brand vibe + the creative brief + the audience — NOT at random. If the doc says "for technical CTOs" → data-density or high-contrast; "for designers" → editorial; "for solo founders" → conversational; "metrics-heavy product" → metric-driven; "AI/chat product" → conversational or brand-first. The right seed makes every scene feel coherent.

${styleSeedCatalog}

Output as \`styleSeed: "<label>"\` at the top level. Do NOT mention the label in the voiceover or headlines — it's a designer cue, not user-facing copy.
`
    : ''

  // Mode catalog the architect picks from. Just id + kind + description —
  // the TSX reference stays in stage 2 where the designer agent uses it.
  const modeCatalog = SCENE_MODES
    .map((m) => `- **${m.id}** (${m.isAbstract ? 'abstract — no browser frame' : 'UI — browser frame inside'}): ${m.description}`)
    .join('\n')

  const visualsLine = input.visualMode === 'mocks'
    ? `**Visuals = MOCKS.** You are the ARCHITECT. You write the script structure AND a per-scene visual brief that 3-4 designer agents will execute IN PARALLEL into TSX. Each designer agent ONLY sees: the scene's headline, voiceover, your visualMode pick, and your visualBrief — it does NOT see the other scenes or the rest of the script. So the brief must be self-contained and concrete.

Set \`screenshotIndex: null\` for every scene (mocks mode never references doc screenshots).

### Per-scene fields you MUST output (in addition to headline/voiceover/duration)

- **\`visualMode\`** — pick the BEST mode for THIS scene's idea from the catalog below. NEVER reuse a mode across scenes within the same video — variety is the headline goal of this architecture. With 3 scenes, mix at least 1 UI + 1 abstract; with 4 scenes, aim for 2 of each.
- **\`visualBrief\`** — 2-3 sentences naming the SPECIFIC elements / numbers / words / motion the designer should put on screen. Be concrete: a designer reading "show that it's fast" can't act on it; a designer reading "Counter ticking from 0 to 12,847 across 1.6s, then drifting +1 every 30 frames. Eyebrow label 'QUERIES THIS MONTH'. Subhead 'and growing'. Use accentColor on the number." builds exactly the right scene. ALWAYS include: the exact text/numbers to show, the focal element (what the eye lands on), and one line on motion.

### Mode catalog (pick ONE per scene, NEVER repeat)

${modeCatalog}
- **custom** (escape hatch): pick this when none of the 8 modes structurally fits the scene's idea — e.g. split-screen before/after, isometric stack, kanban-style motion, thread-of-tweets, an ASCII art reveal. The designer drops the structural template and composes from the brief alone, so your visualBrief MUST be especially concrete (every element + motion spelled out). Use sparingly: prefer a real catalog mode when one fits. The 'never repeat' rule still applies — only ONE custom scene per video.

### Mode dispatch — fight the default-trio bias

Past videos converged on the SAME trio across totally different products: \`flow-diagram + chat + bento\`. That's the model's lazy default. RESIST IT — the catalog has 9 modes for a reason. The dispatcher below maps beat types to modes; favor the LESS-USED ones unless the beat genuinely demands the default:

- **A specific number / metric / claim** ("X% improvement", "10× faster", "save 4 hours") → **hero-stat**. THE most under-used mode. Default to this whenever the headline names a number.
- **A click / action / UX moment** ("one click to invite", "tap to publish", "no setup") → **cursor-click**. Use whenever the value is an in-product action.
- **Live data / growth / comparison** ("see usage rise", "spot trends", "metrics dashboard") → **chart**. Use whenever the headline is about charts, growth, or trends.
- **A brand opener / closer** (hook scene, CTA scene with a "we are X" beat) → **logo-hero**. Always a strong candidate for the HOOK or one bookend.
- **A 3-step process / pipeline / "how it works"** → **flow-diagram**. ONE per video max — don't open and close with flows.
- **AI chat / Q&A as the actual product** → **chat**. ONLY when the product is fundamentally chat-based AND the scene is showing the chat UI specifically. Don't pick chat for "answers questions" on a non-chat product.
- **A multi-card dashboard surface that genuinely shows ≥3 distinct metrics** → **bento**. Use SPARINGLY. The model defaults to bento for everything that isn't obviously another mode — fight that. If the scene is "look at the product", a single hero-stat or chart often beats a generic bento.
- **A literal split / before-after / isometric / kanban / unique idea** → **custom**. Use whenever the standard modes feel forced.

**Anti-default rule:** across your scenes, the trio \`flow-diagram + chat + bento\` is BANNED unless the product is literally a chat-based dashboard with a 3-step pipeline. For a typical product feature page, your scene mix should include AT LEAST 2 of: hero-stat, cursor-click, logo-hero, chart, custom. If you find yourself reaching for bento twice or chat for a non-chat product, stop — pick a different mode.

**IMPORTANT — never duplicate the headline.** The composition layer ALWAYS draws the scene's \`headline\` field in a separate panel beside the mock visual. So the mock visual itself MUST NOT render the headline text again — that would look like two titles glued together. The mock illustrates the IDEA of the headline (a counter for a metric headline, a flow for a process headline, a chat UI for a Q&A headline) — not a giant copy of the same words.

**Reminder on richness:** every brief — even on abstract modes — names AT LEAST ONE supporting visual element beyond the text (motif, gradient, sparkline, parallax, geometric shape, animated indicator). A brief that says only "headline X with subhead Y" is incomplete; add the motif. The designer can't add visual richness if the brief doesn't request it.

**Reminder on restraint (2026 aesthetic):** each scene gets ONE focal element with the brand accent — the hero number, the CTA button, the user chat bubble, the middle node of a flow. Every other element stays neutral (zinc / white / black). Briefs that ask for "accent gradient bg + accent border + accent number + accent button" produce 2018-era branded mockups, not 2026 marketing video. When you write the brief, name the single focal element AND explicitly call out that supporting elements are zinc/neutral. Modern marketing video is restrained; let the eye land on ONE point of color per scene.

**Texture cues (steal these in briefs when they fit):** subtle dot-grid backdrop on a card · frosted/glass element layered on top · low-contrast palette (zinc-700 body, zinc-900 only for the focal title) · asymmetric balance (focal at 35-45% not dead-center) · mixed type weights (tiny eyebrow + huge hero number) · soft thin shadows (not heavy multi-layer drops) · generous whitespace.`
    : `**Visuals = SCREENSHOTS.** Every scene MUST have \`screenshotIndex\` set to a real doc screenshot index (0..${Math.max(0, input.availableScreenshots - 1)}). If a scene has no relevant screenshot, set \`screenshotIndex: null\` and the renderer shows an accent gradient placeholder. Do NOT output \`visualMode\` or \`visualBrief\` in screenshots mode.`

  return `You are writing the SKELETON of a 45-second marketing video script for a SaaS product feature.

This is stage 1 of a two-stage generation: get the script structure (hook + scene voiceovers + scene headlines + cta + timing) right. Per-scene visuals (TSX animations) are generated by a separate parallel pass — you do NOT write any TSX in this output.

The video has THREE acts:
- HOOK (4-6s): one strong opening line that makes the viewer pause their scroll. Specific to the product, not generic ("save time" / "be productive" → no).
- SCENES (3-4 scenes, 7-10s each): each scene shows ONE benefit / capability. The narrator says it; the headline reinforces it visually. Prefer 3 sharp scenes over 4 watered-down ones.
- CTA (4-6s): clear call-to-action with a short button label.

Total duration MUST be EXACTLY 45 seconds. Allocate the budget like this:
  hook + sum(scenes) + cta = 45.0 (±0.5 OK, NOT more).

Keep voice-over CONCISE — target **85 words total** across all parts (NOT 100; audio tags + em-dashes + ellipses each add real silence at synthesis time, so spoken duration consistently exceeds the word-count estimate). Short punchy sentences. Sentence fragments are OK ("Built for speed."). Active verbs. No filler. Better to be slightly under 45s than over.

## Source documentation

Product: ${input.productName}
Feature page: ${input.pageTitle}

Markdown content (use as the ONLY source of truth — don't invent features):
${input.pageMarkdown.slice(0, 6000)}
${briefBlock}${styleSeedBlock}

## Available screenshots (from the same doc)

${captionList || '(no screenshots available — every scene MUST have screenshotIndex: null)'}

You may set "screenshotIndex" to any integer between 0 and ${Math.max(0, input.availableScreenshots - 1)}, OR to null if a scene works better headline-only (e.g. the hook). Reuse a screenshot if the same view illustrates two benefits.

## Visual mode

${visualsLine}

## Language

Write the entire script in **${input.language}**. Do not switch languages mid-script. UI labels in another language stay verbatim in quotes.

## Tone

Confident, specific, benefit-driven. No buzzwords ("revolutionary", "next-gen", "game-changer" → all banned). Active voice. Concrete verbs.

## Voice-over delivery — ElevenLabs v3 formatting (CRITICAL)

The voiceover strings will be fed to ElevenLabs v3 TTS as a single concatenated narration. Without delivery cues the read comes out flat. Bake in the cues:

**Punctuation drives delivery:**
- Em dash (—) creates a short, punchy pause. Use it for emphasis or beat changes.
- Ellipsis (...) creates trailing silence — uses real seconds, so use SPARINGLY (max once across the whole script).
- CAPS for one or two key words signal vocal stress (NOT whole sentences).
- Questions (with ?) create natural rising intonation; only use if the tone allows.

**Audio tags are stage directions** — they MUST appear in the voiceover strings, placed BETWEEN sentences (never mid-sentence). A voiceover string with NO tags AND no emphatic punctuation is a FAILED output and will be regenerated.

Available tags:
Emotional: [excited], [happy], [calm]
Reactions: [laughs], [giggles], [happy gasp], [sighs]
Delivery: [whispers], [cheerfully], [sarcastic]
Pacing: [short pause]

Tags go inside the relevant voiceover string. They count as 0 spoken words for the word-count budget.

### REQUIRED for the selected voice tone (${input.tone ?? 'punchy'})

${TONE_TAG_DIRECTION[input.tone ?? 'punchy']}

This is a MUST, not a suggestion. Across the 5 voiceover strings (1 hook + 3-4 scenes + 1 cta), you MUST land 2-3 audio tags total + at least one CAPS-emphasized word + at least one em-dash for a punchy beat.

### Concrete voiceover examples for tone="${input.tone ?? 'punchy'}"

These are EXACTLY the shape voiceover strings should have. Notice tags between sentences, em-dashes for beats, occasional CAPS:

${TONE_VOICEOVER_EXAMPLES[input.tone ?? 'punchy']}

## Output

Return ONLY valid JSON matching the response schema, no markdown fences, no preamble. Notice the voiceover values include audio tags + emphatic punctuation as REQUIRED above.

Final check before returning: hook.durationSeconds + sum(scenes[].durationSeconds) + cta.durationSeconds MUST equal totalDurationSeconds. Word counts MUST be realistic at 2.3 words/second.`
}

async function generateScriptSkeleton(
  input: GenerateMarketingScriptInput,
): Promise<MarketingScript> {
  const userPrompt = buildSkeletonPrompt(input)

  // Sonnet 4.6 via tool-use for structured JSON output. The Gemini
  // ResponseSchema is structurally a JSON Schema (SchemaType.OBJECT
  // === "object" etc. at runtime), so it drops straight into Anthropic's
  // input_schema field. The helper forces the model to invoke a single
  // `submit_response` tool whose input matches the schema, then returns
  // JSON.stringify(input) — the rest of the parsing path (JSON.parse +
  // Zod validation below) is unchanged.
  const result = await generateSonnetText({
    userPrompt,
    maxTokens: 16_384,
    temperature: 0.6,
    jsonSchema: SKELETON_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
  })

  let jsonStr = result.text.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) jsonStr = fenceMatch[1]!
  const firstBrace = jsonStr.indexOf('{')
  const lastBrace = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }
  jsonStr = jsonStr
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,(\s*[}\]])/g, '$1')

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(jsonStr)
  } catch (err) {
    const repaired = repairTruncatedJson(jsonStr)
    if (repaired !== null) {
      try {
        parsedJson = JSON.parse(repaired)
        console.warn('[marketing-script/skeleton] JSON repaired after parse error:', (err as Error).message)
      } catch {
        console.error('[marketing-script/skeleton] JSON parse failed. First 500 chars:', jsonStr.slice(0, 500))
        throw new Error(`Marketing script skeleton JSON parse failed: ${(err as Error).message}`)
      }
    } else {
      console.error('[marketing-script/skeleton] JSON parse failed. First 500 chars:', jsonStr.slice(0, 500))
      throw new Error(`Marketing script skeleton JSON parse failed: ${(err as Error).message}`)
    }
  }

  const REQUIRED_TOP_LEVEL = ['hook', 'scenes', 'cta', 'totalDurationSeconds'] as const
  const obj = (parsedJson as Record<string, unknown> | null) ?? {}
  const missingTop = REQUIRED_TOP_LEVEL.filter((k) => !(k in obj))
  if (missingTop.length === REQUIRED_TOP_LEVEL.length) {
    console.error('[marketing-script/skeleton] Model returned no usable structure. Raw text (first 800 chars):', result.text.slice(0, 800))
    throw new Error('Marketing script skeleton produced no usable JSON structure. Please retry.')
  }

  const parsed = MarketingScriptSchema.safeParse(parsedJson)
  if (!parsed.success) {
    const preview = JSON.stringify(parsedJson).slice(0, 1000)
    console.error('[marketing-script/skeleton] Gemini returned (first 1000 chars):', preview)
    console.error('[marketing-script/skeleton] Zod issues:', JSON.stringify(parsed.error.issues))
    throw new Error(`Marketing script skeleton JSON failed validation: ${JSON.stringify(parsed.error.issues)}`)
  }

  const max = input.availableScreenshots - 1
  const validated = parsed.data as MarketingScript
  return {
    ...validated,
    hook: {
      ...validated.hook,
      voiceover: stripBrokenAudioTags(validated.hook.voiceover),
    },
    scenes: validated.scenes.map((s) => ({
      ...s,
      voiceover: stripBrokenAudioTags(s.voiceover),
      screenshotIndex:
        s.screenshotIndex == null ? null : Math.max(0, Math.min(max, s.screenshotIndex)),
    })),
    cta: {
      ...validated.cta,
      voiceover: stripBrokenAudioTags(validated.cta.voiceover),
    },
  }
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Two-stage generation — architect / designer pattern.
 *  1. Architect (skeleton call): one Flash call. Returns the full
 *     script structure (hook + scene voiceovers + headlines + timing
 *     + cta) AND, per scene, a `visualMode` pick + a concrete
 *     `visualBrief` (2-3 sentences naming exact elements / numbers /
 *     motion). The architect sees the WHOLE video so it can enforce
 *     variety + visual coherence between scenes.
 *  2. Designers (per-scene calls): N parallel Pro calls, one per
 *     scene. Each designer ONLY sees its own scene + the architect's
 *     brief + the assigned mode's reference template. It implements
 *     the brief in TSX.
 *
 * Wall-clock latency = max(skeleton, max(designer)) instead of the
 * cumulative time of the old monolithic prompt. Quality climbs
 * because:
 *  - The architect picks coherent modes across scenes (no
 *    orchestrator-side random assignment that ignores headline fit).
 *  - Each designer's prompt is FOCUSED on a single scene + brief,
 *    not buried under a 500-line mode catalog.
 *
 * Per-scene failure is non-fatal: the service-side compile + rescue
 * loop calls repairMockCode (or the deterministic fallback) on any
 * scene that comes back without mockCode. One bad scene shouldn't
 * sink the whole video.
 */
export async function generateMarketingScript(
  input: GenerateMarketingScriptInput,
): Promise<MarketingScript> {
  const skeleton = await generateScriptSkeleton(input)

  // Screenshots mode: no mockCode generation — every scene uses a
  // real doc screenshot, the renderer falls back to ScreenshotFrame.
  if (input.visualMode !== 'mocks') {
    return skeleton
  }

  // Resolve the whole-video aesthetic from the architect's pick. Fall
  // back to a random orchestrator-side seed when the architect dropped
  // the field or picked an unknown label.
  const archSeedLabel = skeleton.styleSeed
  const archSeed = archSeedLabel ? STYLE_SEEDS.find((s) => s.label === archSeedLabel) : undefined
  const fallbackSeed = pickStyleSeed()
  const resolvedSeed = archSeed ?? fallbackSeed
  if (archSeedLabel && !archSeed) {
    console.warn(
      `[marketing-script] architect picked unknown styleSeed "${archSeedLabel}" — falling back to "${fallbackSeed.label}"`,
    )
  }

  // Resolve each scene's mode from the architect's pick, with a
  // fallback to a random orchestrator-side assignment when the model
  // dropped the field. Architect can also pick "custom" when none of
  // the catalog modes structurally fit — that bypasses the lookup and
  // hands the designer a free-composition prompt.
  const fallbackModes = pickSceneModes(skeleton.scenes.length)
  const resolvedModes: SceneMode[] = skeleton.scenes.map((scene, i) => {
    const archPick = scene.visualMode
    if (archPick === 'custom') return CUSTOM_MODE
    if (archPick) {
      const found = SCENE_MODES.find((m) => m.id === archPick)
      if (found) return found
      console.warn(
        `[marketing-script/scene-${i}] architect picked unknown visualMode "${archPick}" — falling back to "${fallbackModes[i]?.id}"`,
      )
    }
    return fallbackModes[i] ?? fallbackModes[0]!
  })
  const styleSeedBrief = resolvedSeed.brief
  console.info(
    `[marketing-script] stage 2: ${skeleton.scenes.length} parallel mockCode calls, modes=[${resolvedModes.map((m) => m.id).join(', ')}], briefs=[${skeleton.scenes.map((s) => (s.visualBrief ? 'yes' : 'no')).join(', ')}]`,
  )

  const mockCodes = await Promise.all(
    skeleton.scenes.map((scene, i) =>
      generateSceneMockCode({
        scene,
        mode: resolvedModes[i] ?? resolvedModes[0]!,
        productName: input.productName,
        styleSeed: styleSeedBrief,
        visualBrief: scene.visualBrief ?? '',
      }).catch((err) => {
        console.warn(
          `[marketing-script/scene-${i}/${resolvedModes[i]?.id ?? '?'}] mockCode gen failed: ${(err as Error).message}`,
        )
        return undefined
      }),
    ),
  )

  return {
    ...skeleton,
    // Persist the resolved seed (architect-picked or orchestrator
    // fallback) so a later "regenerate scene N with same look" UX
    // can reuse it.
    styleSeed: resolvedSeed.label,
    scenes: skeleton.scenes.map((s, i) => {
      const mockCode = mockCodes[i]
      return mockCode ? { ...s, mockCode } : s
    }),
  }
}

