import express from 'express'
import cors from 'cors'
import type { Request, Response } from 'express'
import { authMiddleware } from '../src/shared/middleware/auth.middleware.js'
import { runRouter } from '../src/features/run/run.routes.js'
import { questionsRouter } from '../src/features/questions/questions.routes.js'
import { documentationRouter } from '../src/features/documentation/documentation.routes.js'
import { errorHandler } from '../src/shared/middleware/error.middleware.js'

const app = express()

app.use(cors())
app.use(express.json())

// Health check (no auth)
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' })
})

// Protected routes
app.use('/api/runs', authMiddleware, runRouter)
app.use('/api/runs', authMiddleware, questionsRouter)
app.use('/api/runs', authMiddleware, documentationRouter)

app.use(errorHandler)

export default app
