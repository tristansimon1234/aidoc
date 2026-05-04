import { z } from 'zod'

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

// Template helpers
const TemplateListItemSchema = z.object({
  text: z.string().min(1).max(160),
  icon: z.string().max(40).optional(),
})
const TemplateFlowNodeSchema = z.object({
  icon: z.string().min(1).max(40),
  label: z.string().min(1).max(40),
  accent: z.boolean().optional(),
})
const TemplateChartPointSchema = z.object({
  label: z.string().min(1).max(20),
  value: z.number(),
})
const TemplateMockFrameCardSchema = z.object({
  title: z.string().min(1).max(60),
  subtitle: z.string().max(120).optional(),
  pillText: z.string().max(20).optional(),
  pillTone: z.enum(['accent', 'success', 'warning', 'danger', 'muted']).optional(),
})

/** Discriminated union of structured visual templates. The LLM picks a
 *  `kind` and fills the slots; the Remotion bundle has a fixed React
 *  component per kind. Zero TSX generation, zero compile/runtime risk. */
export const SceneTemplateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hero-text'),
    headline: z.string().min(1).max(120),
    subhead: z.string().max(160).optional(),
    layout: z.enum(['center', 'left', 'burst']).optional(),
  }),
  z.object({
    kind: z.literal('kpi-reveal'),
    metric: z.string().min(1).max(40),
    value: z.string().min(1).max(20),
    sub: z.string().max(80).optional(),
    trend: z.enum(['up', 'down', 'flat']).optional(),
  }),
  z.object({
    kind: z.literal('list-reveal'),
    title: z.string().min(1).max(80),
    items: z.array(TemplateListItemSchema).min(1).max(8),
  }),
  z.object({
    kind: z.literal('mock-frame'),
    url: z.string().max(80).optional(),
    appName: z.string().max(40).optional(),
    cards: z.array(TemplateMockFrameCardSchema).min(1).max(6),
  }),
  z.object({
    kind: z.literal('chat-bubble'),
    appName: z.string().max(40).optional(),
    question: z.string().min(1).max(200),
    answer: z.string().min(1).max(400),
  }),
  z.object({
    kind: z.literal('flow-diagram'),
    nodes: z.array(TemplateFlowNodeSchema).min(2).max(5),
  }),
  z.object({
    kind: z.literal('chart'),
    type: z.enum(['bar', 'line']),
    title: z.string().max(80).optional(),
    points: z.array(TemplateChartPointSchema).min(2).max(12),
  }),
  // Phase 3
  z.object({
    kind: z.literal('before-after'),
    beforeLabel: z.string().min(1).max(40),
    afterLabel: z.string().min(1).max(40),
    beforeText: z.string().max(120).optional(),
    afterText: z.string().max(120).optional(),
    beforeIcon: z.string().max(40).optional(),
    afterIcon: z.string().max(40).optional(),
  }),
  z.object({
    kind: z.literal('comparison-bars'),
    leftLabel: z.string().min(1).max(40),
    rightLabel: z.string().min(1).max(40),
    rows: z.array(z.object({
      feature: z.string().min(1).max(60),
      left: z.boolean(),
      right: z.boolean(),
    })).min(2).max(6),
  }),
  z.object({
    kind: z.literal('quote'),
    text: z.string().min(1).max(300),
    author: z.string().min(1).max(40),
    role: z.string().max(60).optional(),
    company: z.string().max(40).optional(),
    avatarUrl: z.string().url().optional(),
  }),
  z.object({
    kind: z.literal('step-progression'),
    steps: z.array(z.object({
      title: z.string().min(1).max(60),
      description: z.string().max(120).optional(),
    })).min(2).max(5),
  }),
  z.object({
    kind: z.literal('big-stat'),
    value: z.string().min(1).max(12),
    label: z.string().max(60).optional(),
    sub: z.string().max(80).optional(),
  }),
  z.object({
    kind: z.literal('live-typing'),
    language: z.enum(['shell', 'js', 'json', 'http']).optional(),
    lines: z.array(z.string().max(120)).min(1).max(8),
  }),
  z.object({
    kind: z.literal('dual-screen'),
    leftUrl: z.string().max(80).optional(),
    rightUrl: z.string().max(80).optional(),
    leftCards: z.array(TemplateMockFrameCardSchema).min(1).max(3),
    rightCards: z.array(TemplateMockFrameCardSchema).min(1).max(3),
  }),
])

/** Zod for what Gemini returns as the marketing script. Field names mirror
 *  MarketingScript so the parsed output drops straight into the service. */
export const MarketingSceneSchema = z.object({
  voiceover: z.string().min(1),
  headline: z.string().min(1),
  subhead: z.string().optional(),
  screenshotIndex: z.number().int().nullable(),
  durationSeconds: z.number().positive(),
  /** Structured template — preferred. */
  template: SceneTemplateSchema.optional(),
  mock: MarketingMockSchema.optional(),
  /** Free TSX (escape hatch). Compiled server-side; bundle reads
   *  mockCompiledCode. */
  mockCode: z.string().max(6_000).optional(),
  /** Compiled JS — populated by the service after esbuild runs. Not
   *  emitted by the LLM; we set it on the manifest before save. */
  mockCompiledCode: z.string().max(20_000).optional(),
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
  totalDurationSeconds: z.number().positive(),
  language: z.string().default('en'),
})

/** Voice-over tone presets. Each maps to a tuned (stability, style,
 *  similarityBoost) triplet on the ElevenLabs side — surface them as
 *  named choices to the user instead of three opaque sliders. */
export const VoiceTonePresetSchema = z.enum(['punchy', 'calm', 'playful', 'serious'])
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

const MarketingBrandingSchema = z.object({
  productName: z.string(),
  accentColor: z.string(),
  bgColor: z.string(),
  textColor: z.string(),
  fontFamily: z.string(),
  logoUrl: z.string().nullable(),
})

export const UpdateMarketingManifestSchema = z.object({
  script: MarketingScriptSchema,
  screenshots: z.array(MarketingScreenshotSchema).optional(),
  branding: MarketingBrandingSchema.optional(),
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
   *  prompt by the service. */
  aiMusicPrompt: z.string().max(300).optional(),
  userPrompt: z.string().max(800).optional(),
})
