import { Router, json } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError, NotFoundError } from '../../shared/middleware/error.middleware.js'
import { ChatRequestSchema, WalkthroughRequestSchema } from './chat.schema.js'
import * as chatService from './chat.service.js'
import { registerChatSession, incrementUsage } from '../../shared/usage/usage.repository.js'
import { logChatMessages } from '../analytics/analytics.repository.js'
import { classifyMessageContent, applyClassificationToMessage } from '../analytics/analytics.service.js'
import { enforceQuotaOrThrow } from '../../shared/middleware/quota.middleware.js'
import { createLimiter } from '../../shared/rate-limit/rate-limit.js'
import type { Project } from '../project/project.types.js'

// Widget session tracking — awaited so `incrementUsage` actually fires on
// Vercel (fire-and-forget gets killed when the function tears down).
async function trackWidgetSession(project: Project, sessionToken: string | undefined): Promise<void> {
  if (!sessionToken || sessionToken.length < 8 || sessionToken.length > 128) return
  try {
    const isNew = await registerChatSession(project.id, project.teamId, sessionToken, 'widget')
    if (isNew) await incrementUsage(project.teamId, 'chat_sessions')
  } catch (err) {
    console.warn('[usage] widget session track failed:', (err as Error).message)
  }
}

export const widgetRouter = Router()

// Distributed rate limiters (Upstash when configured, in-memory fallback
// for local dev). Keyed by widget API key so a noisy widget can't starve
// another one.
const chatLimiter = createLimiter('widget:chat', { limit: 30, windowSec: 60 })
const walkthroughLimiter = createLimiter('widget:walkthrough', {
  limit: 10,
  windowSec: 60,
  message: 'Walkthrough rate limit exceeded. Try again in a minute.',
})

// --- In-memory suggestions cache (1h TTL) ---
const suggestionsCache = new Map<string, { suggestions: string[]; expiresAt: number }>()
const SUGGESTIONS_TTL_MS = 3_600_000 // 1 hour

function getCachedSuggestions(projectId: string): string[] | null {
  const entry = suggestionsCache.get(projectId)
  if (!entry || Date.now() > entry.expiresAt) return null
  return entry.suggestions
}

function setCachedSuggestions(projectId: string, suggestions: string[]): void {
  suggestionsCache.set(projectId, { suggestions, expiresAt: Date.now() + SUGGESTIONS_TTL_MS })
}

// Public chat endpoint — API key auth, no Supabase JWT
widgetRouter.post('/:widgetKey/chat', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const widgetKey = req.params.widgetKey as string
      if (!widgetKey) throw new ValidationError('Widget key is required')

      await chatLimiter.checkOrThrow(widgetKey)

      // Validate API key → find project
      const { findProjectByWidgetKey } = await import('../project/project.repository.js')
      const project = await findProjectByWidgetKey(widgetKey)
      if (!project) throw new NotFoundError('Widget not found or disabled')

      // Block the widget owner's team when its monthly quota is exhausted.
      await enforceQuotaOrThrow(project.teamId)

      const body = ChatRequestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      // Billing: register the chat session (dedup per cookie+month). Run the
      // tracker + classifier in parallel with the chat Gemini call so neither
      // adds user-visible latency.
      const sessionToken = (req.body as { sessionToken?: string }).sessionToken
      const sessionTrackPromise = trackWidgetSession(project, sessionToken)
      const classifyPromise = sessionToken
        ? classifyMessageContent(body.data.message)
        : Promise.resolve(null)

      const result = await chatService.chat(
        project.id,
        body.data.message,
        body.data.history,
        body.data.userContext,
      )

      // Only expose walkthroughAvailable if the project has walkthrough enabled
      if (!project.walkthroughEnabled) {
        delete result.walkthroughAvailable
      }

      if (sessionToken) {
        try {
          const { userMessageId } = await logChatMessages({
            projectId: project.id,
            userId: project.userId,
            sessionToken,
            source: 'widget',
            userMessage: body.data.message,
            assistantMessage: result.answer,
          })
          const classified = await classifyPromise
          if (userMessageId && classified) {
            await applyClassificationToMessage(userMessageId, classified)
          }
        } catch (err) {
          console.warn('[analytics] widget chat log failed:', (err as Error).message)
        }
      }

      await sessionTrackPromise

      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})

// Public endpoint to check widget status (for the embed script)
widgetRouter.get('/:widgetKey/config', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const widgetKey = req.params.widgetKey as string
      if (!widgetKey) throw new ValidationError('Widget key is required')

      const { findProjectByWidgetKey } = await import('../project/project.repository.js')
      const project = await findProjectByWidgetKey(widgetKey)
      if (!project) throw new NotFoundError('Widget not found or disabled')

      // Use cached suggestions — never block config on AI generation
      let suggestions = getCachedSuggestions(project.id)
      if (suggestions === null) {
        // Return empty now, generate in background for next request
        suggestions = []
        void chatService.getSuggestions(project.id).then((s) => {
          setCachedSuggestions(project.id, s)
        }).catch(() => {})
      }

      // Cache at edge for 5 minutes — avoids cold starts on repeat loads
      res.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')

      res.status(200).json({
        projectName: project.name,
        enabled: project.widgetEnabled,
        suggestions,
        design: project.design ?? null,
        widgetPosition: project.design?.widgetPosition ?? 'right',
        widgetGreeting: project.design?.widgetGreeting ?? '',
      })
    } catch (err) {
      next(err)
    }
  })()
})

// Walkthrough endpoint — larger body limit for DOM snapshot payload
const largeJsonParser = json({ limit: '200kb' })

widgetRouter.post('/:widgetKey/walkthrough', largeJsonParser, (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const widgetKey = req.params.widgetKey as string
      if (!widgetKey) throw new ValidationError('Widget key is required')

      await walkthroughLimiter.checkOrThrow(widgetKey)

      const { findProjectByWidgetKey } = await import('../project/project.repository.js')
      const project = await findProjectByWidgetKey(widgetKey)
      if (!project) throw new NotFoundError('Widget not found or disabled')
      if (!project.walkthroughEnabled) throw new NotFoundError('Walkthrough not enabled for this project')

      const body = WalkthroughRequestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const wtSessionToken = (req.body as { sessionToken?: string }).sessionToken
      trackWidgetSession(project, wtSessionToken)

      const result = await chatService.generateWalkthrough(
        project.id,
        {
          message: body.data.message,
          history: body.data.history,
          domSnapshot: body.data.domSnapshot,
          completedSteps: body.data.completedSteps ?? [],
          userContext: body.data.userContext ?? undefined,
        },
      )

      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})
