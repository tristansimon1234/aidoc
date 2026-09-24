import { z } from 'zod'

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().url().default('http://localhost:5173'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  // Utilisée par le service vidéo (Railway) uniquement.
  GEMINI_API_KEY: optional,
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_TTS_MODEL: z.string().default('gemini-2.5-flash-preview-tts'),
  ELEVENLABS_API_KEY: optional,
  ELEVENLABS_VOICE_ID: z.string().default('JBFqnCBsd6RMkjVDRZzb'),
  // Service vidéo sur Railway. Sans URL (en local), le traitement tourne dans le même process.
  VIDEO_SERVICE_URL: optional,
  // Secret partagé entre Vercel et Railway (en-tête x-video-service-secret).
  VIDEO_SERVICE_SECRET: optional,
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  STRIPE_PRICE_PACK: optional,
  STRIPE_PRICE_MONTHLY: optional,
})

export const env = EnvSchema.parse(process.env)
