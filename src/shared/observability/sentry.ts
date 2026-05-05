import * as Sentry from '@sentry/node'
import { env } from '../config/env.js'

let initialised = false

/**
 * Initialise Sentry for the Node serverless runtime. Idempotent — safe to
 * call multiple times (cold starts may re-invoke). When SENTRY_DSN is not
 * set, Sentry becomes a no-op: captureException / captureMessage calls
 * return without doing anything, keeping local dev + self-hosted installs
 * free of external dependencies.
 */
export function initSentry(): void {
  if (initialised) return
  if (!env.SENTRY_DSN) {
    // Explicit no-op: we still flip the flag so we don't keep re-checking.
    initialised = true
    return
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    // VERCEL_GIT_COMMIT_SHA is injected by Vercel on every deployment — use
    // it as the release marker so stack traces line up with the right commit.
    release: env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,
    // Sample rate 1.0 for errors — the volume is low enough that we'd rather
    // see everything. Tracing is off (we're not doing APM yet).
    tracesSampleRate: 0,
    // Redact anything that smells like a secret before it leaves the process.
    beforeSend(event) {
      if (event.request?.headers) {
        const h = event.request.headers as Record<string, string>
        if (h.authorization) h.authorization = '[Redacted]'
        if (h.cookie) h.cookie = '[Redacted]'
        if (h['x-api-key']) h['x-api-key'] = '[Redacted]'
      }
      // Drop anything that looks like an MCP token URL. Tokens are hashed at
      // rest (see mcp.repository.hashMcpToken) but they transit in query /
      // path segments on /api/mcp-user/:token — we don't want them in
      // breadcrumbs.
      // Also strip ?email= so invite-page errors don't leak the invitee
      // address (we put it in the accept URL for prefill — see
      // team.service.ts).
      if (event.request?.url) {
        event.request.url = event.request.url
          .replace(/\/mcp-user\/[^/?#]+/, '/mcp-user/[Redacted]')
          .replace(/([?&])email=[^&#]*/gi, '$1email=[Redacted]')
      }
      return event
    },
  })

  initialised = true
}

export { Sentry }
