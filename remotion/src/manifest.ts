import { z } from 'zod'

/**
 * Re-declares the manifest shape on the Remotion side instead of importing
 * from `src/features/marketing-video/marketing-video.types.ts`. Keeping the
 * Remotion bundle independent of the backend tsconfig means we can ship the
 * video templates without bundling Express, Supabase, etc.
 *
 * Source of truth lives in marketing-video.types.ts — keep these in sync.
 */

/** A single tone label that maps to a brand-aware color in the renderer.
 *  We keep this as an enum (vs hex codes from the LLM) so the rendered
 *  mocks always respect the project's accent color and the dark/light
 *  frame contrast. */
export const MockToneSchema = z.enum(['default', 'muted', 'accent', 'success', 'warning', 'danger'])

/** Each MockElement is a small named primitive — terminal line, pill,
 *  button, etc. Recursive via `group` for layout composition. The
 *  Remotion-side DynamicMock renderer maps these one-to-one to React
 *  components with frame-driven animations.
 *
 *  Why this shape: Gemini struggles to generate working framer-motion +
 *  React code reliably AND framer-motion doesn't compose with Remotion's
 *  per-frame rendering anyway. The DSL gives the LLM editorial freedom
 *  (which elements, what text, what timings) while keeping the actual
 *  rendering deterministic. */
const BaseMockElementSchema = z.object({
  /** Seconds from the start of the scene at which this element fades in.
   *  Default 0 (visible from frame 0). Used by Gemini to stagger lines
   *  for a "typing in" feel — `0`, `0.25`, `0.5`, `0.75`. */
  delay: z.number().min(0).max(20).optional(),
})

type MockElement =
  | { type: 'header'; label: string; icon?: string; statusText?: string; statusTone?: z.infer<typeof MockToneSchema>; delay?: number }
  | { type: 'terminalLine'; prefix?: string; text: string; tone?: z.infer<typeof MockToneSchema>; indent?: boolean; trailingHighlight?: string; delay?: number }
  | { type: 'blinkingCursor'; delay?: number }
  | { type: 'card'; title?: string; rows: { left: string; right?: string; tone?: z.infer<typeof MockToneSchema> }[]; delay?: number }
  | { type: 'pill'; text: string; tone?: z.infer<typeof MockToneSchema>; delay?: number }
  | { type: 'pulsingDot'; tone?: z.infer<typeof MockToneSchema>; size?: number; delay?: number }
  | { type: 'button'; label: string; primary?: boolean; delay?: number }
  | { type: 'input'; placeholder?: string; value?: string; focused?: boolean; delay?: number }
  | { type: 'spacer'; height?: number }
  | { type: 'text'; text: string; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; tone?: z.infer<typeof MockToneSchema>; weight?: 'normal' | 'bold'; delay?: number }
  | { type: 'counter'; from: number; to: number; prefix?: string; suffix?: string; delay?: number }
  | { type: 'avatar'; initials: string; tone?: z.infer<typeof MockToneSchema>; delay?: number }
  | { type: 'codeLine'; lineNumber?: number; tokens: { text: string; tone?: z.infer<typeof MockToneSchema> }[]; delay?: number }
  | { type: 'group'; layout: 'row' | 'column'; gap?: number; align?: 'start' | 'center' | 'end' | 'between'; children: MockElement[]; delay?: number }

export const MockElementSchema: z.ZodType<MockElement> = z.lazy(() => z.discriminatedUnion('type', [
  BaseMockElementSchema.extend({
    type: z.literal('header'),
    label: z.string(),
    icon: z.string().optional(),
    statusText: z.string().optional(),
    statusTone: MockToneSchema.optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('terminalLine'),
    prefix: z.string().optional(),
    text: z.string(),
    tone: MockToneSchema.optional(),
    indent: z.boolean().optional(),
    trailingHighlight: z.string().optional(),
  }),
  BaseMockElementSchema.extend({ type: z.literal('blinkingCursor') }),
  BaseMockElementSchema.extend({
    type: z.literal('card'),
    title: z.string().optional(),
    rows: z.array(z.object({
      left: z.string(),
      right: z.string().optional(),
      tone: MockToneSchema.optional(),
    })),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('pill'),
    text: z.string(),
    tone: MockToneSchema.optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('pulsingDot'),
    tone: MockToneSchema.optional(),
    size: z.number().optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('button'),
    label: z.string(),
    primary: z.boolean().optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('input'),
    placeholder: z.string().optional(),
    value: z.string().optional(),
    focused: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('spacer'),
    height: z.number().optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('text'),
    text: z.string(),
    size: z.enum(['xs', 'sm', 'md', 'lg', 'xl']).optional(),
    tone: MockToneSchema.optional(),
    weight: z.enum(['normal', 'bold']).optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('counter'),
    from: z.number(),
    to: z.number(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('avatar'),
    initials: z.string().min(1).max(3),
    tone: MockToneSchema.optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('codeLine'),
    lineNumber: z.number().optional(),
    tokens: z.array(z.object({ text: z.string(), tone: MockToneSchema.optional() })),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('group'),
    layout: z.enum(['row', 'column']),
    gap: z.number().optional(),
    align: z.enum(['start', 'center', 'end', 'between']).optional(),
    children: z.array(MockElementSchema),
  }),
]))

export const MockSchema = z.object({
  /** Optional browser-chrome wrapper. Drop this for "free-floating" mocks
   *  (a chat widget overlay, a notification toast). */
  frame: z.object({
    url: z.string().max(80).optional(),
    tone: z.enum(['light', 'dark']).optional(),
  }).optional(),
  /** Top-level layout for the elements. Defaults to 'column'. */
  layout: z.enum(['row', 'column']).optional(),
  elements: z.array(MockElementSchema).max(20),
})

export const SceneSchema = z.object({
  voiceover: z.string(),
  headline: z.string(),
  subhead: z.string().optional(),
  screenshotIndex: z.number().nullable(),
  durationSeconds: z.number().positive(),
  /** Legacy DSL mock kept for backwards-compat with persisted manifests. */
  mock: MockSchema.optional(),
  /** Raw TSX written by the LLM. Diagnostics only — bundle runs
   *  `mockCompiledCode`. */
  mockCode: z.string().optional(),
  /** esbuild output of mockCode. The bundle's <DynamicScene>
   *  evaluates this with React + Remotion + branding bound. */
  mockCompiledCode: z.string().optional(),
  /** Architect-picked mode label for the scene (hero-stat / bento /
   *  chat / …). Persisted in manifests for round-trip + diagnostics. */
  visualMode: z.string().optional(),
  /** Architect-written brief naming the elements / motion the
   *  designer should put on screen. Persisted for round-trip. */
  visualBrief: z.string().optional(),
  /** Optional cadrage hint (browser / mobile / terminal / fullbleed /
   *  split). When absent the renderer is unaffected — the mockCode is
   *  responsible for its own framing. Kept here so an editor UI can
   *  surface the architect's pick without re-deriving it from the TSX. */
  framing: z.string().optional(),
  /** When false, the composition layer skips the headline panel and
   *  the mock owns the full 1920×1080 canvas. Default true (canvas
   *  is split: headline panel + 920×580 mock area). Pick this for a
   *  single cinematic shot where any second on-screen title would
   *  compete with the visual; the voice-over carries the narrative. */
  headlinePanel: z.boolean().optional(),
})

// (thumbnail fields are on the manifest, not the scene — see below)

export const ScriptSchema = z.object({
  hook: z.object({
    voiceover: z.string(),
    headline: z.string(),
    durationSeconds: z.number().positive(),
  }),
  scenes: z.array(SceneSchema),
  cta: z.object({
    voiceover: z.string(),
    headline: z.string(),
    buttonLabel: z.string(),
    durationSeconds: z.number().positive(),
  }),
  /** Snapshot of the total duration. Optional in input — when omitted
   *  the renderer derives it from the parts via `totalDurationInFrames`.
   *  Kept on persisted manifests as a cached value. */
  totalDurationSeconds: z.number().positive().optional(),
  language: z.string(),
  /** Aesthetic seed for the whole video. Either a known STYLE_SEEDS
   *  label or a free-text architect brief. */
  styleSeed: z.string().optional(),
})

export const ScreenshotSchema = z.object({
  url: z.string(),
  caption: z.string(),
})

export const BrandingSchema = z.object({
  productName: z.string(),
  accentColor: z.string(),
  /** Optional secondary accent for two-tone gradients / variant chips. Falls
   *  back to a darker shade of `accentColor` when absent. */
  accentSecondary: z.string().optional(),
  bgColor: z.string(),
  textColor: z.string(),
  fontFamily: z.string(),
  logoUrl: z.string().nullable(),
  /** Public URL of the user's product (e.g. https://doclee.tech). Drives the
   *  Cta scene's URL line and any "where to find this" affordance. Optional
   *  for backwards-compat with manifests rendered before this field existed —
   *  the renderer falls back to a `<slug>.com` heuristic when null. */
  websiteUrl: z.string().nullable().optional(),
  /** Corner radius (px) used by primitives + Cta button. Default 14. */
  radius: z.number().min(0).max(64).optional(),
})

export const ManifestSchema = z.object({
  runId: z.string(),
  generatedAt: z.string(),
  script: ScriptSchema,
  screenshots: z.array(ScreenshotSchema),
  branding: BrandingSchema,
  voiceoverUrl: z.string().nullable(),
  voiceoverPath: z.string().nullable(),
  /** Approximate duration (seconds) of the voice-over MP3 as actually
   *  synthesized — different from script.totalDurationSeconds because
   *  ElevenLabs adds real time for [short pause] tags, ellipses, and
   *  em-dashes. The composition uses max(script, voiceover) so the
   *  audio never gets cut off. */
  voiceoverDurationSeconds: z.number().positive().optional(),
  /** Optional background music track URL — mixed into the composition
   *  at low volume so it sits under the voice-over. Null = silent. */
  musicUrl: z.string().nullable().optional(),
  /** Linear volume 0–1 for the music track. Defaults to 0.15 (subtle).
   *  Bumped down further automatically inside scenes if needed. */
  musicVolume: z.number().min(0).max(1).optional(),
})

export type Manifest = z.infer<typeof ManifestSchema>
export type Scene = z.infer<typeof SceneSchema>
export type Script = z.infer<typeof ScriptSchema>
export type Screenshot = z.infer<typeof ScreenshotSchema>
export type Branding = z.infer<typeof BrandingSchema>
export type Mock = z.infer<typeof MockSchema>
export type MockTone = z.infer<typeof MockToneSchema>
