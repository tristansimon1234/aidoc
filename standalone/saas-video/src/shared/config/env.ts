import { z } from 'zod'

/**
 * Env vars validated at startup. Anything required in production fails fast
 * here rather than silently 500ing the first time it's accessed. Kept
 * intentionally short — the original Doclee env had a lot of vars that
 * don't apply here (Browserbase, Anthropic, Resend, etc.).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.coerce.number().default(3000),

  // Supabase — Postgres + Auth + Storage. Service key is server-side only;
  // never expose to the browser. The frontend uses VITE_SUPABASE_ANON_KEY.
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),

  // AI providers
  GEMINI_API_KEY: z.string().min(1),
  // Marketing script generation uses Anthropic Sonnet (architect + designer
  // passes) + Haiku (skeleton). The mock-rendered output quality is too
  // dependent on Sonnet's structured output to risk a model swap right now.
  ANTHROPIC_API_KEY: z.string().min(1),
  ELEVENLABS_API_KEY: z.string().optional(),

  // Remotion render service — re-uses the same deployed service Doclee uses
  // until we spin up our own. Optional in dev so the rest of the stack
  // boots without it; the generate route 503s when unset.
  VIDEO_SERVICE_URL: z.string().url().optional(),

  // Stripe — credit-pack purchases. Both required in production (verified
  // below). The webhook secret is what Stripe signs each event with so we
  // can verify the request actually came from Stripe and not a forged caller.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Public app URL — used to build Stripe Checkout success/cancel URLs and
  // any future outbound email link. Required in production so we never
  // hand Stripe a localhost callback.
  PUBLIC_APP_URL: z.string().url().optional(),

  // Sentry — optional. No-op when unset.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_RELEASE: z.string().optional(),

  // Upstash Redis — distributed rate limiting. In-memory fallback is fine
  // for local dev but bypassable on Vercel (cold starts reset counters), so
  // production requires both. Checked below.
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
})

export type Env = z.infer<typeof EnvSchema>

export const env: Env = EnvSchema.parse(process.env)

// Fail-fast in production for the env vars that affect billing or rate
// limiting — these are the ones where a missing value would silently
// break user-facing flows rather than just disable an optional feature.
if (env.NODE_ENV === 'production') {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    throw new Error(
      'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must both be set in production. ' +
      'Without them, paid credit-pack purchases cannot be processed.',
    )
  }
  if (!env.PUBLIC_APP_URL) {
    throw new Error('PUBLIC_APP_URL must be set in production (used for Stripe Checkout callbacks).')
  }
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must both be set in production. ' +
      'The in-memory rate-limit fallback is bypassable on serverless.',
    )
  }
  if (!env.VIDEO_SERVICE_URL) {
    throw new Error('VIDEO_SERVICE_URL must be set in production — the render pipeline depends on it.')
  }
}
