import * as Sentry from '@sentry/node'
import { env } from '../config/env.js'

let initialised = false

/**
 * Initialise Sentry for the Node serverless runtime. Idempotent. No-op when
 * SENTRY_DSN is unset so local dev runs without external dependencies.
 */
export function initSentry(): void {
  if (initialised) return
  if (!env.SENTRY_DSN) {
    initialised = true
    return
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    beforeSend(event) {
      // Strip auth-ish headers from any captured request payload.
      if (event.request?.headers) {
        const h = event.request.headers as Record<string, string>
        if (h.authorization) h.authorization = '[Redacted]'
        if (h.cookie) h.cookie = '[Redacted]'
        if (h['stripe-signature']) h['stripe-signature'] = '[Redacted]'
      }
      return event
    },
  })

  initialised = true
}

export { Sentry }
