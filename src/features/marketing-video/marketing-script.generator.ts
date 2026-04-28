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
#### Hard rules — non-negotiable, the previous render had ALL of these wrong

1. **Light mode ONLY** — use \`<Remotion.MockFrame tone='light'>\`. No \`tone='dark'\`. Even for terminal-style scenes, use a light-on-dark INSIDE block, not a dark frame. The video lives on a white canvas; dark frames look like glued-on cards.
2. **Outer AbsoluteFill has NO background.** Use \`<Remotion.AbsoluteFill style={{ overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>\`. NO \`background:\` property at all. The FeatureScene canvas (white, branded) shows through.
3. **Use Tailwind className for static styling.** Inline \`style={{}}\` ONLY for dynamic interpolated values (opacity, transform, computed colors). Everything static (padding, rounded corners, shadows, layout, colors that don't depend on frame) → \`className='rounded-2xl p-6 bg-white shadow-2xl ...'\`. Twind is installed; every Tailwind utility works at runtime.
4. **Cursor alignment recipe — STRICT.**
   When you put a cursor on a target:
   - Place the target with FLEX CENTERING, not absolute coords. e.g. inside the MockFrame: \`<div className='flex items-center justify-center h-full'><button className='...'>Click</button></div>\`. The button's center is now at the parent's center.
   - The cursor's terminal coordinates MUST match the button's center. If the button is in a flex-centered parent that fills the MockFrame interior, that center in panel-relative coords is approximately leftPct=50, topPct=55 (50% horizontal, slightly below center because the chrome bar takes ~6% of the height).
   - Use \`<Remotion.AnimatedCursor leftPct={cursorLeft} topPct={cursorTop} ... />\` with leftPct/topPct interpolated from a starting position (e.g. 80, 15) to the target (50, 55).
   - DON'T put cursors on off-center elements (like a Copy button next to an input). Either center the target or skip the cursor.
- Available React: \`React.useMemo\`, \`React.useEffect\` will not work usefully (frames re-render fresh) — for animation use Remotion only.
- Available Remotion namespace (use as \`Remotion.foo\`):
  - \`Remotion.useCurrentFrame()\` → number, the current frame within the scene's sub-timeline (NOT the whole video). Frame 0 is the start of THIS scene.
  - \`Remotion.useVideoConfig()\` → \`{ fps, durationInFrames, width, height }\`.
  - \`Remotion.interpolate(input, [in1, in2, …], [out1, out2, …], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })\` — the workhorse for animation.
  - \`Remotion.spring({ frame, fps, config: { damping, stiffness, mass } })\` — natural easing.
  - \`Remotion.AbsoluteFill\` (component) — fills its parent.
  - \`Remotion.Img\` (component) — for remote images, use sparingly.

  **Pre-built designed helpers (USE THESE — saves boilerplate, ensures consistency):**

  - \`<Remotion.MockFrame url='app.example.com/path' tone='light' | 'dark' style={...}>{children}</Remotion.MockFrame>\`
    Designed browser-window chrome with macOS traffic lights + URL bar + content area. THE OUTERMOST element of every mock — saves you ~30 lines of chrome boilerplate per scene. Children fill the area below the chrome bar. \`tone='dark'\` for terminal/code, \`'light'\` for product UI.

  - \`<Remotion.Pill tone='success' | 'warning' | 'danger' | 'accent' | 'muted' dot accentColor={branding.accentColor}>connected</Remotion.Pill>\`
    Status pill matching the MCPMock "connected" indicator. Dot prefix optional. accentColor is required when tone='accent'.

  - \`<Remotion.AccentGlow color={branding.accentColor} frame={frame} size={540} position='center' />\`
    Cinematic blurred-circle backdrop. Place AS A SIBLING of the MockFrame (in the outer container, BEHIND the frame). Pass \`frame\` to enable the breathing pulse, omit for static. Position can be center / top / bottom / left / right.

  - \`<Remotion.AnimatedCursor leftPct={50} topPct={70} ripple={click} rippleRadius={r} rippleOpacity={ro} accentColor={branding.accentColor} />\`
    Animated mouse cursor SVG + optional click ripple. \`leftPct\` / \`topPct\` are percentages (0-100) of the parent. To align with a flex-centered button: set leftPct=50, topPct=50 (same coords as the button's center via translate -50% -50%) and the cursor lands ON the button.

  - \`<Remotion.Icons.Plug size={14} color='currentColor' />\` — Lucide icons. Available names:
    Plug, Mic, Check, Message, Search, Zap, Code, Settings, MousePointer, Send, Sparkles, Loader, Bell, User, Lock, Globe, ChevronRight, Plus, X, Copy, Play, Pause, Volume, Image, ArrowRight, Activity. They take \`size\` (px) and standard SVG props.

  - \`Remotion.Charts\` — recharts components for data-driven scenes. Available: \`ResponsiveContainer\`, \`LineChart\`, \`Line\`, \`AreaChart\`, \`Area\`, \`BarChart\`, \`Bar\`, \`PieChart\`, \`Pie\`, \`Cell\`, \`XAxis\`, \`YAxis\`, \`CartesianGrid\`, \`Tooltip\`. Wrap charts in \`<Remotion.Charts.ResponsiveContainer width='100%' height='100%'>...</Remotion.Charts.ResponsiveContainer>\` inside a fixed-size parent (e.g. a card body 280×140). Disable Recharts' built-in animation (\`isAnimationActive={false}\`) and instead drive the data via \`Remotion.interpolate(frame, ...)\` so the chart "draws in" frame by frame:

    \`\`\`tsx
    const progress = Remotion.interpolate(f, [10, 60], [0, 1], { extrapolateRight: 'clamp' })
    const data = baseData.map((d, i) => ({ x: d.x, y: d.y * (i / data.length <= progress ? 1 : 0) }))
    <Remotion.Charts.LineChart data={data}>...</Remotion.Charts.LineChart>
    \`\`\`
- Inline styles ONLY. NO Tailwind class names, NO \`className\`, NO external CSS. Everything goes through \`style={{...}}\`.
- NO event handlers (\`onClick\`, \`onMouseMove\`, …). The output is rendered server-side, no interaction.
- NO network access (\`fetch\`, \`XMLHttpRequest\`). NO timers (\`setTimeout\`, \`setInterval\`).
- Code length: HARD CAP **2500 characters per mockCode value**. Enough room for layered backgrounds + 2-3 animated elements + a striking treatment, but tight enough to fit four rich scenes in the response token budget.
- Minify-friendly style: prefer one-liners with semicolons over multi-line bodies. The compiler runs esbuild on it anyway.

#### Canvas dimensions — IMPORTANT for alignment

Your mock renders inside a **920 wide × 580 tall** panel (the visual half of the scene; the text headline sits in the OTHER half). That's your full coordinate space — NOT 1920×1080. Position everything relative to this.

**Prefer flex centering over absolute pixel coordinates** — it's the #1 cause of misaligned cursors, off-target ripples, and elements that drift. Pattern:

\`\`\`tsx
// Outer container: full panel, flex center
<Remotion.AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
  // Element you want centered: just renders, no need to compute (460-w/2, 290-h/2)
  <div style={{ width: 280, height: 80, ... }}>Create token</div>
</Remotion.AbsoluteFill>
\`\`\`

When you DO need absolute positioning (cursor, ripple), use percentages anchored on the SAME center point:

\`\`\`tsx
// Cursor terminal position = panel center = 50%/50%
<div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>...</div>
\`\`\`

This way the cursor lands ON the centered button regardless of exact pixel measurements. NO MORE "cursor clicks empty space".

#### Visual style (this is the "wahou" — REQUIRED, not optional)

Every scene MUST look like a polished product video frame, not a wireframe. The mandatory recipe:

**1. Browser-frame chrome wrapper (MANDATORY, EVERY scene).**
Wrap your entire content in a faux-browser window. The frame has rounded corners, a soft shadow, and a chrome bar at the top with three macOS traffic-light dots + a URL bar. This is what makes the mock read as "a screenshot of a real product" instead of "boxes on a canvas". The frame floats inside the 920×580 panel — leave ~20px margin all around so the shadow can breathe.

**2. The frame's interior is the actual content.**
Inside the browser frame: a designed UI panel (terminal, dashboard, chat, settings). Use a DARK interior (\`#0B0B0F\`, \`#16161A\`) for terminal/code/MCP-style scenes; LIGHT interior (\`#FAFAFA\`, \`#FFFFFF\`) for product-UI/dashboard scenes. Decide per scene.

**3. Accent glow behind the frame** — large blurred circle in \`branding.accentColor\` (\`width: 500-700px, filter: 'blur(120px)', opacity: 0.3-0.5\`, pulses with \`Math.sin(frame/14)\`). Lives outside the frame, on the panel's outer canvas. Adds cinematic depth.

**4. Type hierarchy inside the frame.**
- A small uppercase header label (\`fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted\`) — like "CLAUDE · MCP" or "DOCLEE WORKSPACE".
- A status pill on the right (e.g. "connected" with green dot, "active" with pulsing dot).
- Body content at \`fontSize: 14-18\`.
- Numeric / hero accents at \`fontSize: 28-48\`.

**5. Spring easing for entries.** \`Remotion.spring({ frame: frame - delay, fps, config: { damping: 14-18, stiffness: 80-110 } })\` over plain interpolate. Stagger element entries by ~0.2-0.3s so they appear sequentially.

**6. Glassmorphism / pills / chips.** Floating elements use \`backdropFilter: 'blur(20px)'\` + translucent backgrounds + thin 1px borders.
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

#### Reference example A — light dashboard with stat cards (Tailwind-heavy)

\`\`\`tsx
function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const ease = (start) => Remotion.spring({ frame: f - start, fps, config: { damping: 16, stiffness: 90 } })
  const cards = [
    { label: 'Connected LLMs', value: 4, accent: true },
    { label: 'Queries / day',  value: 1247 },
    { label: 'Avg latency',    value: '180ms' },
  ]
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10 overflow-hidden'>
      <Remotion.AccentGlow color={branding.accentColor} frame={f} size={500} />
      <Remotion.MockFrame url={\`\${branding.productName.toLowerCase()}.app/dashboard\`} tone='light'>
        <div className='p-7 flex flex-col gap-5'>
          <div className='flex items-center gap-2.5'>
            <Remotion.Icons.Activity size={14} color={branding.accentColor} />
            <span className='text-[11px] font-bold tracking-widest uppercase text-zinc-500'>This week</span>
            <span className='ml-auto'><Remotion.Pill tone='success' dot>live</Remotion.Pill></span>
          </div>
          <div className='grid grid-cols-3 gap-3'>
            {cards.map((c, i) => {
              const t = ease(10 + i * 8)
              const op = Remotion.interpolate(t, [0, 1], [0, 1])
              const y = Remotion.interpolate(t, [0, 1], [12, 0])
              return <div key={i} className='rounded-xl border border-zinc-200/70 bg-white p-4' style={{ opacity: op, transform: \`translateY(\${y}px)\` }}>
                <div className='text-[11px] font-medium uppercase tracking-wider text-zinc-500 mb-2'>{c.label}</div>
                <div className={\`text-2xl font-bold tabular-nums \${c.accent ? '' : 'text-zinc-900'}\`} style={c.accent ? { color: branding.accentColor } : undefined}>{c.value}</div>
              </div>
            })}
          </div>
        </div>
      </Remotion.MockFrame>
    </Remotion.AbsoluteFill>
  )
}
\`\`\`

#### Reference example B — light chat (typing prompt + AI reply, Tailwind)

\`\`\`tsx
function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const q = 'How do I connect Stripe?'
  const chars = Math.floor(Remotion.interpolate(f, [10, 50], [0, q.length], { extrapolateRight: 'clamp' }))
  const replyT = Remotion.spring({ frame: f - 60, fps, config: { damping: 14, stiffness: 90 } })
  const replyOp = Remotion.interpolate(replyT, [0, 1], [0, 1])
  const replyY = Remotion.interpolate(replyT, [0, 1], [16, 0])
  const blink = (f % 30) < 15
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10 overflow-hidden'>
      <Remotion.AccentGlow color={branding.accentColor} frame={f} size={520} />
      <Remotion.MockFrame url='claude.ai/chat' tone='light'>
        <div className='p-6 flex flex-col gap-4'>
          <div className='flex items-center gap-2.5'>
            <Remotion.Icons.Sparkles size={14} color={branding.accentColor} />
            <span className='text-[11px] font-bold tracking-widest uppercase text-zinc-500'>Claude · Doclee</span>
            <span className='ml-auto'><Remotion.Pill tone='accent' accentColor={branding.accentColor} dot>connected</Remotion.Pill></span>
          </div>
          <div className='self-end max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2.5 text-[14px] text-white' style={{ background: branding.accentColor }}>
            {q.slice(0, chars)}<span className='inline-block w-[2px] h-[12px] ml-[2px] align-middle bg-white' style={{ opacity: blink ? 1 : 0 }} />
          </div>
          <div className='flex gap-3 items-start' style={{ opacity: replyOp, transform: \`translateY(\${replyY}px)\` }}>
            <div className='w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white' style={{ background: branding.accentColor }}>AI</div>
            <div className='flex-1 max-w-[75%] rounded-2xl rounded-tl-sm px-4 py-2.5 bg-zinc-100 border border-zinc-200/70 text-[14px] text-zinc-800'>
              Open <span className='font-mono text-[13px] px-1.5 py-0.5 rounded bg-white border border-zinc-200'>Settings → Integrations</span>, paste your key, hit save.
            </div>
          </div>
        </div>
      </Remotion.MockFrame>
    </Remotion.AbsoluteFill>
  )
}
\`\`\`

#### Reference example C — cursor flies in + clicks centered "Create token"

The button is flex-centered inside the MockFrame interior. Cursor's terminal coords (50, 55) match the button's center → cursor lands on button. ALWAYS use this pattern. Never put cursor on off-center elements.

\`\`\`tsx
function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const btnT = Remotion.spring({ frame: f, fps, config: { damping: 16, stiffness: 90 } })
  const btnOp = Remotion.interpolate(btnT, [0, 1], [0, 1])
  const btnScale = Remotion.interpolate(btnT, [0, 1], [0.96, 1])
  const curT = Remotion.spring({ frame: f - 18, fps, config: { damping: 16, stiffness: 70 } })
  // Start top-right, land at panel center (50, 55) where the flex-centered button sits.
  const curL = Remotion.interpolate(curT, [0, 1], [82, 50])
  const curTp = Remotion.interpolate(curT, [0, 1], [15, 55])
  const click = f >= 56 && f < 64
  const ripple = Remotion.interpolate(f, [56, 80], [0, 70], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const rippleOp = Remotion.interpolate(f, [56, 80], [0.55, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const press = click ? 0.96 : 1
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10 overflow-hidden'>
      <Remotion.AccentGlow color={branding.accentColor} frame={f} size={520} />
      <Remotion.MockFrame url={\`\${branding.productName.toLowerCase()}.app/settings/tokens\`} tone='light'>
        <div className='h-full flex flex-col items-center justify-center gap-3 p-8'>
          <Remotion.Icons.Lock size={28} color={branding.accentColor} />
          <div className='text-[11px] font-bold tracking-widest uppercase text-zinc-500'>API Tokens</div>
          <div className='text-2xl font-bold text-zinc-900 tracking-tight'>Connect your LLM</div>
          <div className='text-sm text-zinc-500 mb-2'>Generate a secure token to authorize Claude.</div>
          <button className='px-7 py-3.5 rounded-xl text-white text-base font-bold shadow-xl' style={{ background: branding.accentColor, boxShadow: \`0 14px 32px \${branding.accentColor}55\`, opacity: btnOp, transform: \`scale(\${btnScale * press})\` }}>Create token</button>
        </div>
      </Remotion.MockFrame>
      <Remotion.AnimatedCursor leftPct={curL} topPct={curTp} ripple={click} rippleRadius={ripple} rippleOpacity={rippleOp} accentColor={branding.accentColor} />
    </Remotion.AbsoluteFill>
  )
}
\`\`\`

#### Reference example D — chart drawing in via Recharts

Use this pattern for any "stats / metrics / growth" scene. The data array is computed each frame from \`Remotion.interpolate\` so the chart appears to "draw" left-to-right.

\`\`\`tsx
function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const base = [120, 140, 175, 168, 220, 260, 245, 310, 360, 380, 420, 480]
  const progress = Remotion.interpolate(f, [10, 90], [0, base.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const data = base.map((v, i) => ({ d: i + 1, v: i < progress ? v : null }))
  const labelT = Remotion.spring({ frame: f - 24, fps, config: { damping: 16, stiffness: 100 } })
  const labelOp = Remotion.interpolate(labelT, [0, 1], [0, 1])
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-10 overflow-hidden'>
      <Remotion.AccentGlow color={branding.accentColor} frame={f} size={500} />
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
}
\`\`\`

These four examples are your baseline. EVERY scene must:
1. Use \`<Remotion.MockFrame tone='light'>\` (light, never dark).
2. Have NO outer background — the AbsoluteFill is transparent.
3. Use Tailwind \`className\` for static styling, \`style={{...}}\` only for animated values.
4. If using a cursor: target the panel center via flex-centering + cursor terminal coords (50, 55).
   - **MAXIMUM ONE \`<Remotion.AnimatedCursor>\` per scene.** Two cursors look like a misplaced overlay error. If the scene's idea has multiple steps (e.g. "click Create token, then copy URL"), pick the ONE most visually meaningful click — usually the first action that creates something — and skip the rest. The voiceover narrates the rest of the flow; the visual just shows the moment.
   - **The click target MUST be stable for the entire scene.** Don't add or remove sibling elements while the cursor is moving toward / clicking on the target — that displaces the target by some unpredictable px and the click lands in empty space. If you need a "result reveal" after the click (e.g. a token card appearing), put it BELOW the static target area, not inserted in a way that re-flows the layout.
   - **MAXIMUM ONE \`<Remotion.MockFrame>\` per scene.** Never nest or stack two MockFrames (e.g. a chat frame fading into a dashboard frame). Pick one product surface per scene; the next scene gets the next surface. Stacked frames read as a render glitch.
5. **Typography — Geist by default, NEVER set fontFamily inline.** The bundle ships Geist Sans as the default for every Tailwind \`text-*\` className. DO NOT override with \`fontFamily: 'ui-monospace, ...'\` or any other stack — that overrides our config and the result looks like a 2014 system-monospace dump. Use the className \`font-mono\` ONLY for actual code, URLs, or terminal lines. NEVER use mono for prose, chat bubbles, button labels, or headings.
6. **Type at scale — make it feel modern.** Headlines \`text-[32px]\` to \`text-[44px]\` (\`font-bold tracking-tight\`). Big numbers / counters \`text-[64px]\` to \`text-[96px]\` (\`tabular-nums tracking-tight\`). Body / chat text \`text-[15px]\` to \`text-[18px]\`. Labels / status pills \`text-[11px] font-bold tracking-widest uppercase\`. Tight letter-spacing on big text is what makes typography feel premium vs. dated.
7. Pick a different mode per scene — dashboard / chat / button-click / chart / etc. Don't repeat.

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
