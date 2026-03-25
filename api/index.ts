import express from 'express'
import type { Request, Response } from 'express'
import { runRouter } from '../src/features/run/run.routes.js'
import { questionsRouter } from '../src/features/questions/questions.routes.js'
import { documentationRouter } from '../src/features/documentation/documentation.routes.js'
import { errorHandler } from '../src/shared/middleware/error.middleware.js'

const app = express()

app.use(express.json())

app.use('/api/runs', runRouter)
app.use('/api/runs', questionsRouter)
app.use('/api/runs', documentationRouter)

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' })
})

app.use(errorHandler)

export default app
