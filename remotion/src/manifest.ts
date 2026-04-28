import { z } from 'zod'

/**
 * Re-declares the manifest shape on the Remotion side instead of importing
 * from `src/features/marketing-video/marketing-video.types.ts`. Keeping the
 * Remotion bundle independent of the backend tsconfig means we can ship the
 * video templates without bundling Express, Supabase, etc.
 *
 * Source of truth lives in marketing-video.types.ts — keep these in sync.
 */

export const SceneSchema = z.object({
  voiceover: z.string(),
  headline: z.string(),
  subhead: z.string().optional(),
  screenshotIndex: z.number().nullable(),
  durationSeconds: z.number().positive(),
})

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
  totalDurationSeconds: z.number().positive(),
  language: z.string(),
})

export const ScreenshotSchema = z.object({
  url: z.string(),
  caption: z.string(),
})

export const BrandingSchema = z.object({
  productName: z.string(),
  accentColor: z.string(),
  bgColor: z.string(),
  textColor: z.string(),
  fontFamily: z.string(),
  logoUrl: z.string().nullable(),
})

export const ManifestSchema = z.object({
  runId: z.string(),
  generatedAt: z.string(),
  script: ScriptSchema,
  screenshots: z.array(ScreenshotSchema),
  branding: BrandingSchema,
  voiceoverUrl: z.string().nullable(),
  voiceoverPath: z.string().nullable(),
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
