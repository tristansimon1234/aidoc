import express from 'express'
import cors from 'cors'
import { authMiddleware } from './shared/middleware/auth.middleware.js'
import { projectRouter } from './features/project/project.routes.js'
import { profileRouter } from './features/profile/profile.routes.js'
import { billingRouter } from './features/billing/billing.routes.js'
import { adminRouter } from './features/admin/admin.routes.js'
import { requireAdmin } from './shared/middleware/admin.middleware.js'
import { pageRouter } from './features/page/page.routes.js'
import { runRouter } from './features/run/run.routes.js'
import { questionsRouter } from './features/questions/questions.routes.js'
import { documentationRouter } from './features/documentation/documentation.routes.js'
import { chatRouter } from './features/chat/chat.routes.js'
import { widgetRouter } from './features/chat/widget.routes.js'
import { mcpRouter } from './features/chat/mcp.routes.js'
import { userMcpRouter } from './features/mcp/user-mcp.routes.js'
import { mcpTokensRouter } from './features/mcp/tokens.routes.js'
import { publicDocsRouter } from './features/page/public-docs.routes.js'
import { analyticsRouter } from './features/analytics/analytics.routes.js'
import { teamRouter, invitePublicRouter } from './features/team/team.routes.js'
import { exportRouter } from './features/export/export.routes.js'
import { marketingVideoRouter } from './features/marketing-video/marketing-video.routes.js'
import { errorHandler } from './shared/middleware/error.middleware.js'

export const app = express()

app.use(cors())
app.use(express.json())

// Public routes — no auth
app.use('/widget', widgetRouter)
app.use('/mcp', mcpRouter)
app.use('/mcp-user', userMcpRouter)
app.use('/docs', publicDocsRouter)
app.use('/invites', invitePublicRouter)

app.use(authMiddleware)

// Account / user profile
app.use('/profile', profileRouter)
app.use('/billing', billingRouter)
app.use('/admin', requireAdmin, adminRouter)
app.use('/teams', teamRouter)
app.use('/mcp-tokens', mcpTokensRouter)

// Project routes
app.use('/projects', projectRouter)
// Mounted BEFORE pageRouter so its `/pages/import` path isn't shadowed by
// the page CRUD routes (which would 404 on a non-UUID "import" segment).
app.use('/projects/:projectId', exportRouter)
app.use('/projects/:projectId/pages', pageRouter)
app.use('/projects/:projectId/chat', chatRouter)
app.use('/projects/:projectId/analytics', analyticsRouter)

// Legacy run routes (still functional)
app.use('/runs', runRouter)
app.use('/runs', questionsRouter)
app.use('/runs', documentationRouter)
app.use('/runs', marketingVideoRouter)

// Error handler
app.use(errorHandler)
