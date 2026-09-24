import { z } from 'zod'

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().url().default('http://localhost:5173'),
  // Sans SUPABASE_URL : mode local (tests sur son poste, sans connexion). Obligatoire en production.
  SUPABASE_URL: optional.pipe(z.string().url().optional()),
  SUPABASE_SERVICE_KEY: optional,
  // Utilisée par le service vidéo (Railway) uniquement.
  GEMINI_API_KEY: optional,
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_TTS_MODEL: z.string().default('gemini-2.5-flash-preview-tts'),
  ELEVENLABS_API_KEY: optional,
  ELEVENLABS_VOICE_ID: z.string().default('JBFqnCBsd6RMkjVDRZzb'),
  // Force le mode local (données sur le disque, pas de connexion) même si SUPABASE_URL est défini.
  // Pour tester sur Railway sans Supabase tout en gardant ses variables.
  LOCAL_MODE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Mode test : pas d'écran de connexion, tout le monde utilise un compte de test partagé.
  // À n'activer que sur un déploiement protégé (ex. preview Vercel protégée), jamais en public.
  DISABLE_LOGIN: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
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
