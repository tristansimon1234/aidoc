import { z } from 'zod'

export const SUPPORTED_LANGUAGES = ['en', 'fr'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const LanguageSchema = z.enum(SUPPORTED_LANGUAGES)

export const UpdateProfileSchema = z.object({
  fullName: z.string().max(120).nullable().optional(),
  preferredLanguage: LanguageSchema.optional(),
})
