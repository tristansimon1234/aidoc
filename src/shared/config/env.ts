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
  VIDEO_SERVICE_URL: z.string().url().optional(),
  // Comma-separated list of emails allowed on admin-only routes.
  ADMIN_EMAILS: z.string().optional(),
  // Transactional email (team invites, future quota alerts, etc.)
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),  // e.g. "doclee <hello@doclee.tech>"
  // Public site URL used for links in outgoing emails
  PUBLIC_APP_URL: z.string().url().optional(),
  // Upstash Redis — distributed rate limiting for public endpoints (widget
  // chat, public-docs chat, page views). Optional: when missing we fall back
  // to an in-memory limiter that's bypassable on serverless (each cold start
  // resets the counter), fine for local dev but weak in prod.
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
})

export type Env = z.infer<typeof EnvSchema>

export const env: Env = EnvSchema.parse(process.env)

// In production, Upstash is required — the in-memory rate-limit fallback is
// trivially bypassable on Vercel serverless (each cold start starts fresh
// counters). Fail fast at boot instead of letting the app run with effectively
// no rate limiting on the public widget / MCP endpoints.
if (env.NODE_ENV === 'production' && (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN)) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must both be set in production. ' +
    'The in-memory rate-limit fallback is bypassable on serverless — configure Upstash before deploying.',
  )
}

const ADMIN_EMAIL_SET = new Set(
  (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return ADMIN_EMAIL_SET.has(email.toLowerCase())
}
