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
          // mockCode: TSX source the LLM writes for this scene's
          // animation. The backend compiles it via esbuild + bundles
          // it server-side; Remotion runs the compiled JS at render
          // time. Just a string in the response schema — Gemini emits
          // it as plain code, no nested structure to constrain.
          mockCode: { type: SchemaType.STRING },
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
Keep voice-over CONCISE — target **85 words total** across all parts (NOT 100; audio tags + em-dashes + ellipses each add real silence at synthesis time, so the spoken duration consistently exceeds the word-count estimate). Short punchy sentences. Sentence fragments are OK ("Built for speed."). Active verbs. No filler ("Don't forget that…", "It's also worth noting…" → cut). Better to be slightly under 45s than over.

## Source documentation

Product: ${input.productName}
Feature page: ${input.pageTitle}

Markdown content (use as the ONLY source of truth — don't invent features):
${input.pageMarkdown.slice(0, 6000)}
${briefBlock}

## Available screenshots (from the same doc)

${captionList || '(no screenshots available — every scene MUST have screenshotIndex: null)'}

You may set "screenshotIndex" to any integer between 0 and ${Math.max(0, input.availableScreenshots - 1)}, OR to null if a scene works better headline-only (e.g. the hook). Reuse a screenshot if the same view illustrates two benefits.

## Visuals — ${input.visualMode === 'mocks' ? 'TSX animations you write (every scene)' : 'real screenshots (every scene)'}

${input.visualMode === 'mocks'
  ? `**Mode = MOCKS.** For every scene you write a small TSX component in the field \`mockCode\`. The component renders an ANIMATED illustration of the scene's idea — a cursor moving and clicking a button, text typing into a prompt, a progress bar filling, a notification toast popping in, a chat bubble appearing, a code line being highlighted. Compose freely; you control the visuals. Always set \`screenshotIndex: null\` in this mode. DO NOT also fill the legacy \`mock\` field.`
  : `**Mode = SCREENSHOTS.** Every scene MUST have \`screenshotIndex\` set to a real doc screenshot index (0..${Math.max(0, input.availableScreenshots - 1)}) and MUST NOT include \`mock\` or \`mockCode\`. If a scene has no relevant screenshot you may set \`screenshotIndex: null\` and the renderer will show an accent gradient placeholder.`}

${input.visualMode === 'mocks' ? `### Mock code — REQUIRED for every scene

For each scene you write a small TSX component as the value of \`mockCode\`. The component receives the project branding via props and uses Remotion's frame-based animation API to draw an animated illustration of what the scene is talking about.

#### Hard constraints (non-negotiable — your code is sandboxed)

- Define a function (or const arrow) named exactly \`MockScene\` that takes \`{ branding }\` as its only prop. The component returns a single root element.
- DO NOT \`import\` or \`require\` anything. \`React\`, \`Remotion\`, and \`branding\` are passed in as parameters; everything you need lives on those.
- **Use SINGLE QUOTES \`'\` for every string literal in the TSX, including JSX attribute values (\`fill='#fff'\`, not \`fill="#fff"\`). Use backticks \` \` only for template literals when you need interpolation. NEVER use double quotes inside the mockCode value. Reason: the mockCode is delivered as a JSON string, so unescaped \`"\` inside it would break the JSON envelope.**
- Available React: \`React.useMemo\`, \`React.useEffect\` will not work usefully (frames re-render fresh) — for animation use Remotion only.
- Available Remotion namespace (use as \`Remotion.foo\`):
  - \`Remotion.useCurrentFrame()\` → number, the current frame within the scene's sub-timeline (NOT the whole video). Frame 0 is the start of THIS scene.
  - \`Remotion.useVideoConfig()\` → \`{ fps, durationInFrames, width, height }\`.
  - \`Remotion.interpolate(input, [in1, in2, …], [out1, out2, …], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })\` — the workhorse for animation.
  - \`Remotion.spring({ frame, fps, config: { damping, stiffness, mass } })\` — natural easing.
  - \`Remotion.AbsoluteFill\` (component) — fills its parent.
  - \`Remotion.Img\` (component) — for remote images, use sparingly.
- Inline styles ONLY. NO Tailwind class names, NO \`className\`, NO external CSS. Everything goes through \`style={{...}}\`.
- NO event handlers (\`onClick\`, \`onMouseMove\`, …). The output is rendered server-side, no interaction.
- NO network access (\`fetch\`, \`XMLHttpRequest\`). NO timers (\`setTimeout\`, \`setInterval\`).
- Code length: HARD CAP **2500 characters per mockCode value**. Enough room for layered backgrounds + 2-3 animated elements + a striking treatment, but tight enough to fit four rich scenes in the response token budget.
- Minify-friendly style: prefer one-liners with semicolons over multi-line bodies. The compiler runs esbuild on it anyway.

#### Visual style (this is the "wahou" — DO follow)

These are MARKETING video frames, not wireframes. Every scene should make a viewer pause. Concrete recipe:

- **Big bold canvas first.** Always start with a full-bleed \`Remotion.AbsoluteFill\` background. Prefer dark backgrounds (\`#0B0B0F\`, \`#0E0E12\`) — accent colors pop harder against dark. Use the project's \`branding.bgColor\` only when it's already dark; otherwise override.
- **Accent glow.** Behind every focal element, place a large blurred circle in \`branding.accentColor\` (\`width: 500-700, height: 500-700, borderRadius: '50%', filter: 'blur(120px)', opacity: 0.4-0.6\`). Pulses with \`Math.sin(frame/12)\`. This is what makes scenes feel cinematic instead of flat.
- **Type at scale.** Hero headlines at \`fontSize: 80-120, fontWeight: 700-800, letterSpacing: '-0.03em'\`. Inline a few words in \`branding.accentColor\` for emphasis. Never use \`fontSize\` under 24 unless it's body text in a UI mock.
- **Spring easing.** Prefer \`Remotion.spring({ frame: frame - delay, fps, config: { damping: 14-18, stiffness: 80-110 } })\` over plain interpolate for entries — it lands with weight instead of stopping cold.
- **Layer depth.** Backgrounds blurred (\`filter: 'blur(100px)'\`), middle layer with gradient borders or scrim, sharp foreground. Shadows: \`boxShadow: '0 24px 80px rgba(0,0,0,0.4)'\`.
- **Glassmorphism for floating UI.** Pills / cards that sit over the bg use \`backdropFilter: 'blur(24px)'\` + \`background: '#FFFFFF14'\` + \`border: '1px solid #FFFFFF22'\`.
- **Big elements, not tiny ones.** Cursors should fly across half the canvas, buttons should be 220-360px wide, text inputs 600-800px. Tiny widgets feel like wireframes.
- Scene duration in seconds is given as \`durationSeconds\` per scene. The frame range for your component is \`0 .. fps × durationSeconds\`.

#### Branding object you receive

\`\`\`ts
branding: {
  productName: string   // "${input.productName}"
  accentColor: string   // hex e.g. "#9755ce"
  bgColor: string       // hex
  textColor: string     // hex
  fontFamily: string    // CSS font stack
  logoUrl: string | null
}
\`\`\`

Use \`branding.accentColor\` for highlights, \`branding.textColor\` for prose, \`branding.fontFamily\` (chained with system-ui fallback) for typography.

#### Animation idioms (steal these)

- Stagger fade + slide for entries:
  \`const opacity = Remotion.interpolate(frame, [start, start+12], [0, 1], { extrapolateRight: 'clamp' })\`
- Type-on text:
  \`const charsShown = Math.floor(Remotion.interpolate(frame, [0, 60], [0, fullText.length], { extrapolateRight: 'clamp' }))\`
  then render \`fullText.slice(0, charsShown)\`.
- Cursor sliding to a target:
  \`const cursorProgress = Remotion.spring({ frame: frame - 12, fps, config: { damping: 18 } })\`
  \`const cursorX = Remotion.interpolate(cursorProgress, [0, 1], [800, targetX])\`
- Pulse / blink:
  \`const blink = (frame % 30) < 15 ? 1 : 0\`
- Click ripple: an absolute-positioned circle whose radius interpolates outward + opacity fades (e.g. \`r = interpolate(frame, [clickFrame, clickFrame+18], [0, 60])\`).

#### Reference example A — hero headline reveal with accent glow

\`\`\`tsx
function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const t = Remotion.spring({ frame: f, fps, config: { damping: 14, stiffness: 90 } })
  const slide = Remotion.interpolate(t, [0, 1], [60, 0])
  const opacity = Remotion.interpolate(t, [0, 1], [0, 1])
  const glowOp = 0.45 + 0.20 * Math.sin(f / 14)
  return (
    <Remotion.AbsoluteFill style={{ background: '#0B0B0F', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', width: 700, height: 700, borderRadius: '50%', background: branding.accentColor, filter: 'blur(140px)', opacity: glowOp }} />
      <div style={{ position: 'relative', opacity, transform: \`translateY(\${slide}px)\`, fontFamily: \`\${branding.fontFamily}, system-ui, sans-serif\`, fontSize: 110, fontWeight: 800, letterSpacing: '-0.03em', color: '#FFFFFF', textAlign: 'center', lineHeight: 1.05 }}>
        Ship docs that <span style={{ color: branding.accentColor }}>convert</span>
      </div>
    </Remotion.AbsoluteFill>
  )
}
\`\`\`

#### Reference example B — big counter ticking up

\`\`\`tsx
function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const ease = 1 - Math.pow(1 - Remotion.interpolate(f, [12, 12 + fps * 1.6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }), 3)
  const value = Math.round(0 + (12_847 - 0) * ease)
  const labelT = Remotion.spring({ frame: f - 24, fps, config: { damping: 18, stiffness: 100 } })
  const labelOp = Remotion.interpolate(labelT, [0, 1], [0, 1])
  const glowOp = 0.5 + 0.2 * Math.sin(f / 12)
  return (
    <Remotion.AbsoluteFill style={{ background: '#0B0B0F', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', width: 600, height: 600, borderRadius: '50%', background: branding.accentColor, filter: 'blur(120px)', opacity: glowOp }} />
      <div style={{ position: 'relative', textAlign: 'center', fontFamily: \`\${branding.fontFamily}, system-ui, sans-serif\` }}>
        <div style={{ fontSize: 200, fontWeight: 800, letterSpacing: '-0.04em', color: '#FFFFFF', fontFeatureSettings: '"tnum"', lineHeight: 1 }}>{value.toLocaleString()}</div>
        <div style={{ marginTop: 24, opacity: labelOp, fontSize: 28, fontWeight: 500, color: '#FFFFFFB0', letterSpacing: '0.02em' }}>docs read this month</div>
      </div>
    </Remotion.AbsoluteFill>
  )
}
\`\`\`

#### Reference example C — cursor flies in and clicks a glass button

\`\`\`tsx
function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const glow = 0.4 + 0.2 * Math.sin(f / 14)
  const buttonT = Remotion.spring({ frame: f, fps, config: { damping: 16, stiffness: 90 } })
  const buttonOp = Remotion.interpolate(buttonT, [0, 1], [0, 1])
  const buttonScale = Remotion.interpolate(buttonT, [0, 1], [0.92, 1])
  const cursorT = Remotion.spring({ frame: f - 18, fps, config: { damping: 16, stiffness: 70 } })
  const cx = Remotion.interpolate(cursorT, [0, 1], [840, 480])
  const cy = Remotion.interpolate(cursorT, [0, 1], [120, 320])
  const click = f >= 60 && f < 70
  const ripple = Remotion.interpolate(f, [60, 86], [0, 110], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const rippleOp = Remotion.interpolate(f, [60, 86], [0.55, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const press = click ? 0.96 : 1
  return (
    <Remotion.AbsoluteFill style={{ background: '#0B0B0F', overflow: 'hidden', fontFamily: \`\${branding.fontFamily}, system-ui, sans-serif\` }}>
      <div style={{ position: 'absolute', left: 240, top: 100, width: 600, height: 600, borderRadius: '50%', background: branding.accentColor, filter: 'blur(140px)', opacity: glow }} />
      <div style={{ position: 'absolute', left: 380, top: 280, width: 320, height: 96, borderRadius: 18, background: branding.accentColor, color: '#FFFFFF', fontSize: 28, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: \`scale(\${buttonScale * press})\`, opacity: buttonOp, boxShadow: \`0 24px 80px \${branding.accentColor}66\`, letterSpacing: '-0.01em' }}>Create token</div>
      <div style={{ position: 'absolute', left: cx - ripple, top: cy + 20 - ripple, width: ripple * 2, height: ripple * 2, borderRadius: '50%', border: \`3px solid \${branding.accentColor}\`, opacity: rippleOp, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', left: cx, top: cy, width: 32, height: 32, pointerEvents: 'none', filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.5))' }}>
        <svg width='32' height='32' viewBox='0 0 24 24'><path d='M3 2l8 18 2-8 8-2z' fill='#FFFFFF' stroke='#000000' strokeWidth='1.4' /></svg>
      </div>
    </Remotion.AbsoluteFill>
  )
}
\`\`\`

#### Reference example D — type a prompt with floating chat bubble reply

\`\`\`tsx
function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const txt = 'Generate the migration script'
  const chars = Math.floor(Remotion.interpolate(f, [10, 60], [0, txt.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }))
  const blink = (f % 30) < 15
  const replyT = Remotion.spring({ frame: f - 75, fps, config: { damping: 14, stiffness: 100 } })
  const replyOp = Remotion.interpolate(replyT, [0, 1], [0, 1])
  const replyY = Remotion.interpolate(replyT, [0, 1], [20, 0])
  const glow = 0.35 + 0.15 * Math.sin(f / 16)
  return (
    <Remotion.AbsoluteFill style={{ background: '#0B0B0F', overflow: 'hidden', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, fontFamily: \`\${branding.fontFamily}, system-ui, sans-serif\` }}>
      <div style={{ position: 'absolute', width: 700, height: 700, borderRadius: '50%', background: branding.accentColor, filter: 'blur(140px)', opacity: glow }} />
      <div style={{ position: 'relative', width: 760, padding: '20px 28px', borderRadius: 999, background: '#FFFFFF14', backdropFilter: 'blur(20px)', border: '1px solid #FFFFFF22', color: '#FFFFFF', fontSize: 26, boxShadow: '0 24px 80px rgba(0,0,0,0.4)' }}>
        {txt.slice(0, chars)}<span style={{ opacity: blink ? 1 : 0, marginLeft: 2, color: branding.accentColor }}>|</span>
      </div>
      <div style={{ position: 'relative', maxWidth: 720, padding: '18px 24px', borderRadius: 18, background: branding.accentColor, color: '#FFFFFF', fontSize: 22, opacity: replyOp, transform: \`translateY(\${replyY}px)\`, boxShadow: \`0 16px 60px \${branding.accentColor}55\`, alignSelf: 'flex-start' }}>
        Done — 3 files updated. Want me to push?
      </div>
    </Remotion.AbsoluteFill>
  )
}
\`\`\`

Use these as the visual baseline. Each scene picks ONE of these patterns (or a sibling — counter, progress bar, code line typing, notification toast, stat cards) and adapts the copy to the scene's headline. Don't downgrade — match this level of polish.

End of TSX section.
` : ''}

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
${input.visualMode === 'mocks'
  ? `      "screenshotIndex": null,
      "mockCode": "<full TSX defining function MockScene({ branding }), see the 'Mock code' section above for two paste-as-template examples>",`
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
    // Bumped to 16384: in mocks mode each scene's mockCode is a ~1-2KB
    // TSX string and 4 scenes × 2KB = 8KB just for code, plus the rest
    // of the script + JSON-escape overhead. 8192 was hitting the cap
    // mid-mockCode and the smart repair couldn't recover the scenes
    // that never made it into the response. 16384 gives ample headroom
    // for the verbose case (mocks mode + tagged voice-over + FR/DE).
    maxTokens: 16_384,
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
