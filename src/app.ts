import express from 'express'
import { runRouter } from './features/run/run.routes.js'
import { questionsRouter } from './features/questions/questions.routes.js'
import { documentationRouter } from './features/documentation/documentation.routes.js'
import { errorHandler } from './shared/middleware/error.middleware.js'

export const app = express()

app.use(express.json())

// Routes
app.use('/runs', runRouter)
app.use('/runs', questionsRouter)
app.use('/runs', documentationRouter)

// Error handler
app.use(errorHandler)
