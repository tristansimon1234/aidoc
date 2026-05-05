import * as Sentry from '@sentry/react'

/**
 * Initialise Sentry for the browser bundle. Reads VITE_SENTRY_DSN — when
 * absent (local dev, self-hosted), initialisation is skipped and
 * `Sentry.captureException` becomes a silent no-op thanks to the default
 * `@sentry/react` behaviour.
 */
export function initBrowserSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
  if (!dsn) return

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    // We don't want to pay for tracing yet — errors only.
    tracesSampleRate: 0,
    beforeSend(event) {
      // Scrub Authorization / cookie / session tokens that may appear in the
      // event metadata. Belt-and-braces: the default integrations don't touch
      // these, but any custom breadcrumb could have captured them.
      if (event.request?.headers) {
        const h = event.request.headers as Record<string, string>
        if (h.authorization) h.authorization = '[Redacted]'
        if (h.cookie) h.cookie = '[Redacted]'
      }
      return event
    },
  })
}

export { Sentry }
