import { z } from 'zod'
import { LenientHexColorSchema } from '../../shared/design/colors.js'
import { isAllowedFontFamily, DEFAULT_FONT } from '../../shared/design/fonts.js'

/** Mirrors MockTone from marketing-video.types.ts. Wrapped in preprocess
 *  so anything Gemini hallucinates ("primary", "highlight", a hex code,
 *  …) becomes undefined instead of failing the whole script validation.
 *  Same trick for frame.tone and mock.layout — defence in depth against
 *  the LLM drifting from the documented enum. */
const TONE_VALUES = ['default', 'muted', 'accent', 'success', 'warning', 'danger'] as const
const MockToneSchema = z.preprocess(
  (v) => (typeof v === 'string' && (TONE_VALUES as readonly string[]).includes(v) ? v : undefined),
  z.enum(TONE_VALUES).optional(),
)

const FRAME_TONE_VALUES = ['light', 'dark'] as const
const FrameToneSchema = z.preprocess(
  (v) => (typeof v === 'string' && (FRAME_TONE_VALUES as readonly string[]).includes(v) ? v : undefined),
  z.enum(FRAME_TONE_VALUES).optional(),
)

const LAYOUT_VALUES = ['row', 'column'] as const
const LayoutSchema = z.preprocess(
  (v) => (typeof v === 'string' && (LAYOUT_VALUES as readonly string[]).includes(v) ? v : undefined),
  z.enum(LAYOUT_VALUES).optional(),
)

/** Single primitive in the mock DSL. Matches MockElement union — Gemini
 *  emits objects with discriminator `type` and a flat set of
 *  type-specific fields. We keep this permissive on missing fields
 *  (rather than discriminated-union strict) because Gemini's
 *  responseSchema can't model discriminated unions and unknown LLM
 *  behaviour is better handled with a soft schema + drop-on-fail. */
const SizeSchema = z.preprocess(
  (v) => (typeof v === 'string' && ['xs', 'sm', 'md', 'lg', 'xl'].includes(v) ? v : undefined),
  z.enum(['xs', 'sm', 'md', 'lg', 'xl']).optional(),
)
const WeightSchema = z.preprocess(
  (v) => (typeof v === 'string' && ['normal', 'bold'].includes(v) ? v : undefined),
  z.enum(['normal', 'bold']).optional(),
)

const MockElementSchema = z.object({
  type: z.string(),
  label: z.string().optional(),
  icon: z.string().optional(),
  statusText: z.string().optional(),
  statusTone: MockToneSchema,
  prefix: z.string().optional(),
  text: z.string().optional(),
  tone: MockToneSchema,
  indent: z.boolean().optional(),
  trailingHighlight: z.string().optional(),
  title: z.string().optional(),
  rows: z.array(z.object({
    left: z.string(),
    right: z.string().optional(),
    tone: MockToneSchema,
  })).optional(),
  primary: z.boolean().optional(),
  placeholder: z.string().optional(),
  value: z.string().optional(),
  focused: z.boolean().optional(),
  height: z.number().optional(),
  size: SizeSchema,
  weight: WeightSchema,
  from: z.number().optional(),
  to: z.number().optional(),
  suffix: z.string().optional(),
  initials: z.string().optional(),
  lineNumber: z.number().optional(),
  tokens: z.array(z.object({
    text: z.string(),
    tone: MockToneSchema,
  })).optional(),
  delay: z.number().min(0).max(20).optional(),
})

const MarketingMockSchema = z.object({
  frame: z.object({
    url: z.string().max(80).optional(),
    tone: FrameToneSchema,
  }).optional(),
  layout: LayoutSchema,
  elements: z.array(MockElementSchema).max(20),
})

/** Zod for what Gemini returns as the marketing script. Field names mirror
 *  MarketingScript so the parsed output drops straight into the service. */
export const MarketingSceneSchema = z.object({
  voiceover: z.string().min(1),
  headline: z.string().min(1),
  subhead: z.string().optional(),
  screenshotIndex: z.number().int().nullable(),
  durationSeconds: z.number().positive(),
  /** Legacy DSL mock — backwards-compat for any persisted manifests. */
  mock: MarketingMockSchema.optional(),
  /** Free TSX written by Gemini / the MCP caller for this scene's
   *  animation. Compiled server-side; the bundle never sees this
   *  directly. Cap raised to 15k after seeing legitimate rewrites at
   *  9-12k once primitives + chrome-optional layouts entered the
   *  vocabulary. The compile step still enforces its own per-scene cap
   *  as a safety net. */
  mockCode: z.string().max(15_000).optional(),
  /** esbuild output of mockCode. Remotion's <DynamicScene> wraps it in
   *  a `new Function(...)` with React + Remotion + branding bound,
   *  evaluates, and renders the resulting component. Cap kept ~1.7×
   *  the source cap to absorb esbuild's helpers + JSX → React.createElement. */
  mockCompiledCode: z.string().max(25_000).optional(),
  /** Architect-picked visual mode for this scene (hero-stat / bento /
   *  chat / …). Skeleton stage 1 fills it; stage 2 reads it to pick
   *  the right reference template. Kept loose (z.string) so a future
   *  mode addition doesn't break existing manifests. */
  visualMode: z.string().max(40).optional(),
  /** Concrete visual brief written by the architect — names the exact
   *  elements / numbers / motion the designer should put on screen.
   *  Forwarded into the per-scene mockCode prompt. The 800-char cap
   *  was too tight after the Sonnet switch — Sonnet writes longer,
   *  more specific briefs (color hexes, exact ticker values, layout
   *  notes) and 800 chars rejected legitimate output. 3000 covers the
   *  rich-brief case while still bounding the prompt size downstream. */
  visualBrief: z.string().max(3000).optional(),
  /** Architect-picked cadrage override (browser / mobile / terminal /
   *  fullbleed / split). Free-string for backwards-compat with future
   *  additions. Loosely capped at 40 chars. */
  framing: z.string().max(40).optional(),
  /** When false, the composition skips the headline panel and the
   *  mock fills the full 1920×1080 canvas. Orthogonal to `framing`:
   *  pick this regardless of cadrage for a "voice-over carries the
   *  story" beat. */
  headlinePanel: z.boolean().optional(),
})

export const MarketingScriptSchema = z.object({
  hook: z.object({
    voiceover: z.string().min(1),
    headline: z.string().min(1),
    durationSeconds: z.number().positive(),
  }),
  scenes: z.array(MarketingSceneSchema).min(1).max(6),
  cta: z.object({
    voiceover: z.string().min(1),
    headline: z.string().min(1),
    buttonLabel: z.string().min(1).max(40),
    durationSeconds: z.number().positive(),
  }),
  /** Total duration in seconds. Optional in input — when omitted (or
   *  inconsistent with the parts) the service derives it via
   *  `computeTotalDuration(script)`. Kept on the persisted manifest as
   *  a snapshot so older manifests round-trip cleanly. */
  totalDurationSeconds: z.number().positive().optional(),
  language: z.string().default('en'),
  /** Aesthetic for the whole video. Either a known STYLE_SEEDS label
   *  (editorial, brutalist, …) or a free-text architect-written brief.
   *  The orchestrator looks up the label first; on miss it treats the
   *  string as the brief verbatim. Cap relaxed to 600 chars so the
   *  architect can write a full creative direction (was 40 — too tight
   *  for free-text). */
  styleSeed: z.string().max(600).optional(),
})

/** Sum of hook + scenes + cta in seconds. Source of truth for any
 *  downstream consumer that needs a total — call this instead of reading
 *  `script.totalDurationSeconds` directly so input scripts that omitted
 *  the field (or got it wrong) still produce a coherent value. */
export function computeTotalDuration(script: {
  hook: { durationSeconds: number }
  scenes: Array<{ durationSeconds: number }>
  cta: { durationSeconds: number }
}): number {
  return (
    script.hook.durationSeconds +
    script.scenes.reduce((acc, s) => acc + s.durationSeconds, 0) +
    script.cta.durationSeconds
  )
}

/** Voice-over tone presets. Each maps to a tuned (stability, style,
 *  similarityBoost) triplet on the ElevenLabs side — surface them as
 *  named choices to the user instead of three opaque sliders. */
export const VoiceTonePresetSchema = z.enum([
  'punchy', 'calm', 'playful', 'serious',
  'confident', 'inspirational', 'conversational',
])
export type VoiceTonePreset = z.infer<typeof VoiceTonePresetSchema>

/** Visual style for the whole video. 'screenshots' uses real doc
 *  screenshots in every scene (the "grounded in real product" path,
 *  high credibility). 'mocks' uses LLM-designed animated UI mocks
 *  in every scene (the "polished, designy" path). The user picks one
 *  mode for the video — no per-scene hybrid. */
export const VisualModeSchema = z.enum(['screenshots', 'mocks'])
export type VisualMode = z.infer<typeof VisualModeSchema>

/** Schema for an incoming manifest update via PUT /:id/marketing-video/manifest.
 *  Same shape as the persisted MarketingManifest but every field beyond the
 *  script is optional — the user typically edits the script (headlines,
 *  durations, mockCode) and we keep the rest from the existing manifest.
 *  The service merges this on top of the persisted version, so a partial
 *  payload doesn't wipe screenshots / branding / voiceover. */
const MarketingScreenshotSchema = z.object({
  url: z.string().url(),
  caption: z.string(),
})

// Hex + font validation lives in the shared design module (imported at
// the top). The persistence path is synchronous; same source of truth
// as project settings, the AI auto-fill route, and the manifest editor.
const ManifestFontFamilySchema = z.preprocess(
  (v) => (typeof v === 'string' && isAllowedFontFamily(v) ? v : DEFAULT_FONT.cssValue),
  z.string(),
)

const MarketingBrandingSchema = z.object({
  productName: z.string(),
  accentColor: LenientHexColorSchema,
  bgColor: LenientHexColorSchema,
  textColor: LenientHexColorSchema,
  fontFamily: ManifestFontFamilySchema,
  logoUrl: z.string().nullable(),
  accentSecondary: LenientHexColorSchema.optional(),
  radius: z.number().min(0).max(64).optional(),
  websiteUrl: z.string().nullable().optional(),
})

/** Partial branding patch — used by the AI edit endpoint where the
 *  model often returns ONLY the field it changed (e.g. accentColor
 *  when the user asked for less purple). The full schema fields stay
 *  required for the source-of-truth manifest persistence. */
const MarketingBrandingPatchSchema = MarketingBrandingSchema.partial()

export const UpdateMarketingManifestSchema = z.object({
  script: MarketingScriptSchema,
  screenshots: z.array(MarketingScreenshotSchema).optional(),
  branding: MarketingBrandingPatchSchema.optional(),
  // Voice-over / music URLs are NOT user-editable here — re-synthesize via
  // POST /:id/marketing-video/voiceover. Accepting the fields would let
  // the user point Remotion at an arbitrary URL.
  musicVolume: z.number().min(0).max(1).optional(),
})

export type UpdateMarketingManifestInput = z.infer<typeof UpdateMarketingManifestSchema>

export const GenerateMarketingVideoOptionsSchema = z.object({
  withVoiceover: z.boolean().optional(),
  voiceId: z.string().optional(),
  tone: VoiceTonePresetSchema.optional(),
  visualMode: VisualModeSchema.optional(),
  // 'none' | '<presetId>' | 'ai' — special value 'ai' triggers ElevenLabs
  // Music generation. Mutually exclusive with musicUploadPath.
  musicTrackId: z.string().optional(),
  musicUploadPath: z.string().optional(),
  musicVolume: z.number().min(0).max(1).optional(),
  /** Free-form steering for AI music generation. Only used when
   *  musicTrackId === 'ai'. Concatenated with a tone-derived base
   *  prompt by the service. 500 chars covers the realistic-brief case
   *  (was 300 — too tight once users started naming instruments,
   *  tempo, and reference tracks together). */
  aiMusicPrompt: z.string().max(500).optional(),
  userPrompt: z.string().max(800).optional(),
})
