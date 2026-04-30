import express from 'express'
import cors from 'cors'
import type { Request, Response } from 'express'
import { authMiddleware } from '../src/shared/middleware/auth.middleware.js'
import { projectRouter } from '../src/features/project/project.routes.js'
import { profileRouter } from '../src/features/profile/profile.routes.js'
import { billingRouter } from '../src/features/billing/billing.routes.js'
import { adminRouter } from '../src/features/admin/admin.routes.js'
import { requireAdmin } from '../src/shared/middleware/admin.middleware.js'
import { pageRouter } from '../src/features/page/page.routes.js'
import { runRouter } from '../src/features/run/run.routes.js'
import { questionsRouter } from '../src/features/questions/questions.routes.js'
import { documentationRouter } from '../src/features/documentation/documentation.routes.js'
import { chatRouter } from '../src/features/chat/chat.routes.js'
import { widgetRouter } from '../src/features/chat/widget.routes.js'
import { mcpRouter } from '../src/features/chat/mcp.routes.js'
import { userMcpRouter } from '../src/features/mcp/user-mcp.routes.js'
import { mcpTokensRouter } from '../src/features/mcp/tokens.routes.js'
import { publicDocsRouter } from '../src/features/page/public-docs.routes.js'
import { analyticsRouter } from '../src/features/analytics/analytics.routes.js'
import { teamRouter, invitePublicRouter } from '../src/features/team/team.routes.js'
import { exportRouter } from '../src/features/export/export.routes.js'
import { marketingVideoRouter } from '../src/features/marketing-video/marketing-video.routes.js'
import { errorHandler } from '../src/shared/middleware/error.middleware.js'

const app = express()

app.use(cors())
app.use(express.json())

// Health check (no auth)
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' })
})

// Public routes (no auth)
app.use('/api/widget', widgetRouter)
app.use('/api/mcp', mcpRouter)
app.use('/api/mcp-user', userMcpRouter)
app.use('/api/docs', publicDocsRouter)
app.use('/api/invites', invitePublicRouter)

// Protected routes
app.use('/api/profile', authMiddleware, profileRouter)
app.use('/api/billing', authMiddleware, billingRouter)
app.use('/api/admin', authMiddleware, requireAdmin, adminRouter)
app.use('/api/teams', authMiddleware, teamRouter)
app.use('/api/mcp-tokens', authMiddleware, mcpTokensRouter)
app.use('/api/projects', authMiddleware, projectRouter)
// Mounted BEFORE pageRouter so its `/pages/import` path isn't shadowed by
// the page CRUD routes (which would 404 on a non-UUID "import" segment).
app.use('/api/projects/:projectId', authMiddleware, exportRouter)
app.use('/api/projects/:projectId/pages', authMiddleware, pageRouter)
app.use('/api/projects/:projectId/chat', authMiddleware, chatRouter)
app.use('/api/projects/:projectId/analytics', authMiddleware, analyticsRouter)
app.use('/api/runs', authMiddleware, runRouter)
app.use('/api/runs', authMiddleware, questionsRouter)
app.use('/api/runs', authMiddleware, documentationRouter)
app.use('/api/runs', authMiddleware, marketingVideoRouter)

app.use(errorHandler)

export default app
