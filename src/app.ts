import express from 'express'
import cors from 'cors'
import { authMiddleware } from './shared/middleware/auth.middleware.js'
import { projectRouter } from './features/project/project.routes.js'
import { pageRouter } from './features/page/page.routes.js'
import { runRouter } from './features/run/run.routes.js'
import { questionsRouter } from './features/questions/questions.routes.js'
import { documentationRouter } from './features/documentation/documentation.routes.js'
import { chatRouter } from './features/chat/chat.routes.js'
import { errorHandler } from './shared/middleware/error.middleware.js'

export const app = express()

app.use(cors())
app.use(express.json())
app.use(authMiddleware)

// Project routes
app.use('/projects', projectRouter)
app.use('/projects/:projectId/pages', pageRouter)
app.use('/projects/:projectId/chat', chatRouter)

// Legacy run routes (still functional)
app.use('/runs', runRouter)
app.use('/runs', questionsRouter)
app.use('/runs', documentationRouter)

// Error handler
app.use(errorHandler)
