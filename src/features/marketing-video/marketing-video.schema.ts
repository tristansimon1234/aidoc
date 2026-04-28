import { z } from 'zod'

/** Zod for what Gemini returns as the marketing script. Field names mirror
 *  MarketingScript so the parsed output drops straight into the service. */
export const MarketingSceneSchema = z.object({
  voiceover: z.string().min(1),
  headline: z.string().min(1),
  subhead: z.string().optional(),
  screenshotIndex: z.number().int().nullable(),
  durationSeconds: z.number().positive(),
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

export const GenerateMarketingVideoOptionsSchema = z.object({
  withVoiceover: z.boolean().optional(),
  voiceId: z.string().optional(),
  tone: VoiceTonePresetSchema.optional(),
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
