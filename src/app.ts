import express from 'express'
import cors from 'cors'
import { initSentry } from './shared/observability/sentry.js'
import { mountRouters } from './shared/middleware/mount-routers.js'
import { errorHandler } from './shared/middleware/error.middleware.js'

// Sentry must initialise before anything else so it can capture errors thrown
// during router mounting / module load. No-op when SENTRY_DSN is unset.
initSentry()

export const app = express()

app.use(cors())
// 2 MB so the internal video-analysis callback (a long demo can carry ~100+
// steps with narration transcripts) isn't rejected by the default 100 kB cap.
// Still modest — public endpoints are rate-limited and carry tiny bodies.
app.use(express.json({ limit: '2mb' }))

// Local dev: Vite proxies /api/* to this server and strips the /api prefix,
// so routes mount at the root. Prod (api/index.ts) mounts at /api.
mountRouters(app, { prefix: '' })

app.use(errorHandler)
