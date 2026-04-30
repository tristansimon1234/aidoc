import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { AppError, ValidationError } from '../../shared/middleware/error.middleware.js'
import { ChatRequestSchema } from './chat.schema.js'
import * as chatService from './chat.service.js'
import { UuidParamSchema } from '../../shared/validation/schemas.js'
import { registerChatSession, incrementUsage, findOwnerUserIdByTeamId } from '../../shared/usage/usage.repository.js'
import { logChatMessages } from '../analytics/analytics.repository.js'
import { enforceQuotaOrThrow } from '../../shared/middleware/quota.middleware.js'
import { assertProjectAccess } from '../project/project.service.js'

export const chatRouter = Router({ mergeParams: true })

function getUserId(req: Request): string {
  const uid = (req as Request & { userId?: string }).userId
  if (!uid) throw new AppError('Unauthorized', 'UNAUTHORIZED', 401)
  return uid
}

/** Parse + assert team membership on the :projectId path param before any
 *  authed chat operation. Returns BOTH projectId and teamId so callers
 *  don't have to re-fetch the project to learn which team owns it (saves
 *  one round-trip on every chat turn — main hot path). 404 on "not a
 *  member" to match the rest of the app. */
async function assertChatAccess(req: Request): Promise<{ projectId: string; teamId: string }> {
  const params = UuidParamSchema.safeParse({ id: req.params.projectId })
  if (!params.success) throw new ValidationError(params.error.flatten())
  try {
    const project = await assertProjectAccess(params.data.id, getUserId(req))
    return { projectId: project.id, teamId: project.teamId }
  } catch {
    throw new AppError('Project not found', 'PROJECT_NOT_FOUND', 404)
  }
}

async function trackAppChatSession(projectId: string, teamId: string, sessionToken: string | undefined): Promise<void> {
  if (!sessionToken || sessionToken.length < 8 || sessionToken.length > 128) return
  try {
    const isNew = await registerChatSession(projectId, teamId, sessionToken, 'app')
    if (isNew) await incrementUsage(teamId, 'chat_sessions')
  } catch (err) {
    console.warn('[usage] app chat session track failed:', (err as Error).message)
  }
}

// Chat with project documentation
chatRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      // Parse the request body upfront — independent of the auth check, so
      // we can race them. Body parse is sync but tiny.
      const body = ChatRequestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      // assertChatAccess already loads the project (auth + team check) and
      // returns the teamId, so we no longer need a second findTeamIdByProjectId.
      // Quota check needs teamId, so it has to come after — but the project
      // load is the only blocker on the read path.
      const { projectId, teamId } = await assertChatAccess(req)

      // Block hard-cap plans before spending on Gemini.
      await enforceQuotaOrThrow(teamId)

      // Classification is deferred to the hourly cron — see analytics.service.
      const sessionToken = (req.body as { sessionToken?: string }).sessionToken
      const sessionTrackPromise = trackAppChatSession(projectId, teamId, sessionToken)

      const result = await chatService.chat(
        projectId,
        body.data.message,
        body.data.history,
        body.data.userContext,
      )

      if (sessionToken) {
        try {
          // chat_messages keeps user_id as audit — pick the team's primary owner.
          const ownerId = await findOwnerUserIdByTeamId(teamId)
          if (ownerId) {
            await logChatMessages({
              projectId,
              userId: ownerId,
              sessionToken,
              source: 'app',
              userMessage: body.data.message,
              assistantMessage: result.answer,
            })
          }
        } catch (err) {
          console.warn('[analytics] app chat log failed:', (err as Error).message)
        }
      }

      await sessionTrackPromise

      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})

// Check if indexed, optionally force re-index
chatRouter.post('/index', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const { projectId } = await assertChatAccess(req)

      const body = req.body as { force?: boolean }
      const { hasEmbeddings } = await import('./chat.repository.js')
      const exists = await hasEmbeddings(projectId)

      // Skip re-indexing if embeddings exist and not forced
      if (exists && !body.force) {
        res.status(200).json({ indexed: 1, cached: true })
        return
      }

      // Project-level lock so two teammates clicking Re-index simultaneously
      // don't both burn embedding tokens for the same data.
      const { ensureExclusiveJob, completeJob, failJob } = await import('../run/job.service.js')
      const job = await ensureExclusiveJob({
        runId: null,
        pageId: null,
        projectId,
        type: 'index',
        triggeredByUserId: getUserId(req),
      })

      try {
        const count = await chatService.indexProject(projectId)
        await completeJob(job.id)
        res.status(200).json({ indexed: count, cached: false })
      } catch (err) {
        await failJob(job.id, (err as Error).message)
        throw err
      }
    } catch (err) {
      next(err)
    }
  })()
})

// Get dynamic suggestions — cached in memory per project
const suggestionsCache = new Map<string, { suggestions: string[]; generatedAt: number }>()
const SUGGESTIONS_TTL_MS = 3600_000 // 1 hour

chatRouter.get('/suggestions', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const { projectId } = await assertChatAccess(req)
      const cached = suggestionsCache.get(projectId)

      if (cached && Date.now() - cached.generatedAt < SUGGESTIONS_TTL_MS) {
        res.setHeader('Cache-Control', 'no-cache')
        res.status(200).json({ suggestions: cached.suggestions })
        return
      }

      const suggestions = await chatService.getSuggestions(projectId)
      if (suggestions.length > 0) {
        suggestionsCache.set(projectId, { suggestions, generatedAt: Date.now() })
      }

      res.setHeader('Cache-Control', 'no-cache')
      res.status(200).json({ suggestions })
    } catch (err) {
      next(err)
    }
  })()
})
