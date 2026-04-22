import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { AppError, ValidationError } from '../../shared/middleware/error.middleware.js'
import { ChatRequestSchema } from './chat.schema.js'
import * as chatService from './chat.service.js'
import { UuidParamSchema } from '../../shared/validation/schemas.js'
import { registerChatSession, incrementUsage, findTeamIdByProjectId, findOwnerUserIdByTeamId } from '../../shared/usage/usage.repository.js'
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
 *  authed chat operation. Returns the projectId so callers can use it
 *  without re-parsing. Treats "not a member" as 404 to match the rest of
 *  the app. */
async function assertChatAccess(req: Request): Promise<string> {
  const params = UuidParamSchema.safeParse({ id: req.params.projectId })
  if (!params.success) throw new ValidationError(params.error.flatten())
  try {
    await assertProjectAccess(params.data.id, getUserId(req))
  } catch {
    throw new AppError('Project not found', 'PROJECT_NOT_FOUND', 404)
  }
  return params.data.id
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
      const projectId = await assertChatAccess(req)

      const body = ChatRequestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const teamId = await findTeamIdByProjectId(projectId)
      if (!teamId) throw new ValidationError('Project not found')

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
      const projectId = await assertChatAccess(req)

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
      const projectId = await assertChatAccess(req)
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
