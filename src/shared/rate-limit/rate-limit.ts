import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { env } from '../config/env.js'
import { AppError } from '../middleware/error.middleware.js'

/**
 * Distributed rate limiter backed by Upstash Redis, with an in-memory fallback
 * when UPSTASH_* env vars are absent (local dev only — the fallback resets on
 * every serverless cold start and is trivially bypassable in prod).
 *
 * Usage:
 *   const chatLimiter = createLimiter('widget:chat', { limit: 30, windowSec: 60 })
 *   await chatLimiter.checkOrThrow(widgetKey)
 *
 * Each limiter keeps its own Redis sliding-window bucket, keyed by
 * `${namespace}:${key}`. Namespaces keep unrelated buckets (chat vs
 * walkthrough vs page-view) from colliding even if the caller passes the
 * same identifier.
 */

interface LimiterOptions {
  /** Max requests allowed within the window. */
  limit: number
  /** Window size in seconds. */
  windowSec: number
  /** Optional: custom error message shown on block. */
  message?: string
}

export interface Limiter {
  /** Returns whether the caller is allowed; does not throw. */
  check(key: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }>
  /** Throws a 429 AppError when the caller is blocked. */
  checkOrThrow(key: string): Promise<void>
}

const redis =
  env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN })
    : null

if (!redis && env.NODE_ENV === 'production') {
  console.warn('[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN not set in production — using in-memory fallback that is bypassable on serverless. Set both env vars to enable distributed rate limiting.')
}

/**
 * In-memory fallback — a fixed-window counter, same semantics as the old
 * per-route Maps. Only used when Upstash is not configured. Shared Map keeps
 * things cheap: at most O(active-keys) entries, GC'd lazily by the next
 * check() call after the window expires.
 */
const memBuckets = new Map<string, { count: number; resetAt: number }>()

function checkMem(fullKey: string, limit: number, windowMs: number): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now()
  let entry = memBuckets.get(fullKey)
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs }
    memBuckets.set(fullKey, entry)
  }
  entry.count++
  return {
    allowed: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    resetAt: entry.resetAt,
  }
}

export function createLimiter(namespace: string, opts: LimiterOptions): Limiter {
  const { limit, windowSec, message } = opts
  const upstash = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
        prefix: `rl:${namespace}`,
        analytics: false,
      })
    : null
  const windowMs = windowSec * 1000
  const defaultMessage = message ?? 'Rate limit exceeded. Try again in a minute.'

  return {
    async check(key: string) {
      const fullKey = `${namespace}:${key}`
      if (upstash) {
        const r = await upstash.limit(fullKey)
        return { allowed: r.success, remaining: r.remaining, resetAt: r.reset }
      }
      return checkMem(fullKey, limit, windowMs)
    },
    async checkOrThrow(key: string) {
      const r = await this.check(key)
      if (!r.allowed) throw new AppError(defaultMessage, 'RATE_LIMITED', 429)
    },
  }
}
