import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.coerce.number().default(3000),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional(),
  BROWSERBASE_API_KEY: z.string().min(1),
  BROWSERBASE_PROJECT_ID: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  ELEVENLABS_API_KEY: z.string().optional(),
})

export type Env = z.infer<typeof EnvSchema>

export const env: Env = EnvSchema.parse(process.env)
