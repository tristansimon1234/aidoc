import type { Express } from 'express'
import { authMiddleware } from './auth.middleware.js'
import { requireAdmin } from './admin.middleware.js'
import { projectRouter } from '../../features/project/project.routes.js'
import { profileRouter } from '../../features/profile/profile.routes.js'
import { billingRouter } from '../../features/billing/billing.routes.js'
import { adminRouter } from '../../features/admin/admin.routes.js'
import { pageRouter } from '../../features/page/page.routes.js'
import { tabRouter } from '../../features/tab/tab.routes.js'
import { runRouter } from '../../features/run/run.routes.js'
import { questionsRouter } from '../../features/questions/questions.routes.js'
import { documentationRouter } from '../../features/documentation/documentation.routes.js'
import { chatRouter } from '../../features/chat/chat.routes.js'
import { widgetRouter } from '../../features/chat/widget.routes.js'
import { mcpRouter } from '../../features/chat/mcp.routes.js'
import { userMcpRouter } from '../../features/mcp/user-mcp.routes.js'
import { mcpTokensRouter } from '../../features/mcp/tokens.routes.js'
import { publicDocsRouter } from '../../features/page/public-docs.routes.js'
import { analyticsRouter } from '../../features/analytics/analytics.routes.js'
import { cronRouter } from '../../features/analytics/cron.routes.js'
import { teamRouter, invitePublicRouter } from '../../features/team/team.routes.js'
import { exportRouter } from '../../features/export/export.routes.js'
import { marketingVideoRouter } from '../../features/marketing-video/marketing-video.routes.js'
import { projectMarketingVideoRouter } from '../../features/marketing-video/project-marketing-video.routes.js'

interface MountOptions {
  /**
   * Path prefix prepended to every route.
   *   - '' in local dev (Vite proxies /api → backend and strips the prefix)
   *   - '/api' when running as the Vercel serverless function
   * Single source of truth so adding a router can't diverge between the two
   * entrypoints.
   */
  prefix: string
}

/**
 * Mount every HTTP route on the provided Express app. Shared between
 * src/app.ts (local dev) and api/index.ts (Vercel serverless) so neither can
 * drift: adding or removing a router is a single edit here.
 *
 * Auth is applied per-router rather than with a single `app.use(authMiddleware)`
 * gate, which keeps the public surface (widget / mcp / public-docs / invites)
 * co-located with the protected one and makes it impossible to accidentally
 * order an auth'd router before the gate and expose it.
 */
export function mountRouters(app: Express, options: MountOptions): void {
  const p = options.prefix

  // Public routes — no JWT. Each applies its own rate limit where relevant.
  app.use(`${p}/widget`, widgetRouter)
  app.use(`${p}/mcp`, mcpRouter)
  app.use(`${p}/mcp-user`, userMcpRouter)
  app.use(`${p}/docs`, publicDocsRouter)
  app.use(`${p}/invites`, invitePublicRouter)
  // Vercel cron handlers — authed via `Authorization: Bearer CRON_SECRET`,
  // not the user JWT.
  app.use(`${p}/cron`, cronRouter)

  // Authed routes.
  app.use(`${p}/profile`, authMiddleware, profileRouter)
  app.use(`${p}/billing`, authMiddleware, billingRouter)
  app.use(`${p}/admin`, authMiddleware, requireAdmin, adminRouter)
  app.use(`${p}/teams`, authMiddleware, teamRouter)
  app.use(`${p}/mcp-tokens`, authMiddleware, mcpTokensRouter)
  app.use(`${p}/projects`, authMiddleware, projectRouter)
  // Mounted BEFORE pageRouter so its `/pages/import` path isn't shadowed by
  // the page CRUD routes (which would 404 on a non-UUID "import" segment).
  app.use(`${p}/projects/:projectId`, authMiddleware, exportRouter)
  app.use(`${p}/projects/:projectId/pages`, authMiddleware, pageRouter)
  app.use(`${p}/projects/:projectId/tabs`, authMiddleware, tabRouter)
  app.use(`${p}/projects/:projectId/chat`, authMiddleware, chatRouter)
  app.use(`${p}/projects/:projectId/analytics`, authMiddleware, analyticsRouter)
  app.use(`${p}/projects/:projectId`, authMiddleware, projectMarketingVideoRouter)
  app.use(`${p}/runs`, authMiddleware, runRouter)
  app.use(`${p}/runs`, authMiddleware, questionsRouter)
  app.use(`${p}/runs`, authMiddleware, documentationRouter)
  app.use(`${p}/runs`, authMiddleware, marketingVideoRouter)
}
