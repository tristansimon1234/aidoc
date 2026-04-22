import express from 'express'
import cors from 'cors'
import type { Request, Response } from 'express'
import { mountRouters } from '../src/shared/middleware/mount-routers.js'
import { errorHandler } from '../src/shared/middleware/error.middleware.js'

const app = express()

app.use(cors())
app.use(express.json())

// Health check (no auth)
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' })
})

// Shared with src/app.ts — mountRouters is the single source of truth for
// every router mount, so the two entrypoints can't drift.
mountRouters(app, { prefix: '/api' })

app.use(errorHandler)

export default app
