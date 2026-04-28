import { z } from 'zod'

/** Mirrors MockTone from marketing-video.types.ts. Kept in sync manually. */
const MockToneSchema = z.enum(['default', 'muted', 'accent', 'success', 'warning', 'danger'])

/** Single primitive in the mock DSL. Matches MockElement union — Gemini
 *  emits objects with discriminator `type` and a flat set of
 *  type-specific fields. We keep this permissive on missing fields
 *  (rather than discriminated-union strict) because Gemini's
 *  responseSchema can't model discriminated unions and unknown LLM
 *  behaviour is better handled with a soft schema + drop-on-fail. */
const MockElementSchema = z.object({
  type: z.string(),
  label: z.string().optional(),
  icon: z.string().optional(),
  statusText: z.string().optional(),
  statusTone: MockToneSchema.optional(),
  prefix: z.string().optional(),
  text: z.string().optional(),
  tone: MockToneSchema.optional(),
  indent: z.boolean().optional(),
  trailingHighlight: z.string().optional(),
  title: z.string().optional(),
  rows: z.array(z.object({
    left: z.string(),
    right: z.string().optional(),
    tone: MockToneSchema.optional(),
  })).optional(),
  primary: z.boolean().optional(),
  placeholder: z.string().optional(),
  value: z.string().optional(),
  focused: z.boolean().optional(),
  height: z.number().optional(),
  size: z.enum(['xs', 'sm', 'md', 'lg', 'xl']).optional(),
  weight: z.enum(['normal', 'bold']).optional(),
  from: z.number().optional(),
  to: z.number().optional(),
  suffix: z.string().optional(),
  initials: z.string().optional(),
  lineNumber: z.number().optional(),
  tokens: z.array(z.object({
    text: z.string(),
    tone: MockToneSchema.optional(),
  })).optional(),
  delay: z.number().min(0).max(20).optional(),
})

const MarketingMockSchema = z.object({
  frame: z.object({
    url: z.string().max(80).optional(),
    tone: z.enum(['light', 'dark']).optional(),
  }).optional(),
  layout: z.enum(['row', 'column']).optional(),
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
  mock: MarketingMockSchema.optional(),
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
