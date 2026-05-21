import express from 'express'
import cors from 'cors'
import { authMiddleware } from './shared/middleware/auth.middleware.js'
import { errorHandler } from './shared/middleware/error.middleware.js'
import { initSentry } from './shared/observability/sentry.js'
import { profileRouter } from './features/profile/profile.routes.js'
import { brandRouter } from './features/brand/brand.routes.js'
import { marketingVideoRouter } from './features/marketing-video/marketing-video.routes.js'
import { creditsRouter, stripeWebhookRouter } from './features/credits/credits.routes.js'

/**
 * Express app — same pattern as Doclee's. Routers are mounted with auth
 * applied per-router rather than globally, which makes the public webhook
 * route impossible to accidentally protect (and makes the protected
 * routes impossible to accidentally expose).
 *
 * Two entry points consume this app:
 *   - src/server.ts        — local dev (calls `mountRoutes(app, '')`)
 *   - api/index.ts         — Vercel serverless function (calls `mountRoutes(app, '/api')`)
 *
 * mountRoutes is exported so both can stay in sync — adding a router is a
 * single edit here and propagates to both runtimes.
 */
export function createApp(): express.Express {
  initSentry()
  const app = express()
  app.use(cors())
  return app
}

interface MountOptions {
  /** '' for local dev, '/api' on Vercel. */
  prefix: string
}

export function mountRoutes(app: express.Express, opts: MountOptions): void {
  const p = opts.prefix

  // Stripe webhook MUST be mounted BEFORE express.json() — the signature
  // is computed over the raw body and any prior body parser would mangle
  // it. The router itself uses express.raw for just its own POST endpoint.
  app.use(`${p}/stripe`, stripeWebhookRouter)

  // JSON parser for everything else.
  app.use(express.json({ limit: '5mb' }))

  // Authed routes.
  app.use(`${p}/profile`, authMiddleware, profileRouter)
  app.use(`${p}/brands`, authMiddleware, brandRouter)
  app.use(`${p}/marketing-videos`, authMiddleware, marketingVideoRouter)
  app.use(`${p}/credits`, authMiddleware, creditsRouter)

  // Health check — no auth, no rate limit, used by uptime monitors.
  app.get(`${p}/health`, (_req, res) => { res.status(200).json({ status: 'ok' }) })

  // Error handler must be last.
  app.use(errorHandler)
}
