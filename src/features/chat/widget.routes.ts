import { Router, json } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError, NotFoundError, AppError } from '../../shared/middleware/error.middleware.js'
import { ChatRequestSchema, WalkthroughRequestSchema } from './chat.schema.js'
import * as chatService from './chat.service.js'
import { registerWidgetSession, incrementUsage } from '../../shared/usage/usage.repository.js'
import type { Project } from '../project/project.types.js'

// Fire-and-forget session tracking: we don't want AI latency coupled to
// billing, and we don't want to block the user if the counter write fails.
function trackWidgetSession(project: Project, sessionToken: string | undefined): void {
  if (!sessionToken || sessionToken.length < 8 || sessionToken.length > 128) return
  void (async () => {
    try {
      const isNew = await registerWidgetSession(project.id, project.userId, sessionToken)
      if (isNew) await incrementUsage(project.userId, 'widget_sessions')
    } catch (err) {
      console.warn('[usage] widget session track failed:', (err as Error).message)
    }
  })()
}

export const widgetRouter = Router()

// --- In-memory rate limiter per API key (separate buckets for chat vs walkthrough) ---
const rateLimitMap = new Map<string, { chatCount: number; walkthroughCount: number; resetAt: number }>()
const CHAT_RATE_LIMIT = 30 // max chat requests per window
const WALKTHROUGH_RATE_LIMIT = 10 // max walkthrough requests per window (more expensive)
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute

function checkRateLimit(key: string, type: 'chat' | 'walkthrough'): void {
  const now = Date.now()
  let entry = rateLimitMap.get(key)

  if (!entry || now > entry.resetAt) {
    entry = { chatCount: 0, walkthroughCount: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }
    rateLimitMap.set(key, entry)
  }

  if (type === 'chat') {
    entry.chatCount++
    if (entry.chatCount > CHAT_RATE_LIMIT) {
      throw new AppError('Rate limit exceeded. Try again in a minute.', 'RATE_LIMITED', 429)
    }
  } else {
    entry.walkthroughCount++
    if (entry.walkthroughCount > WALKTHROUGH_RATE_LIMIT) {
      throw new AppError('Walkthrough rate limit exceeded. Try again in a minute.', 'RATE_LIMITED', 429)
    }
  }
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key)
  }
}, 300_000)

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

      checkRateLimit(widgetKey, 'chat')

      // Validate API key → find project
      const { findProjectByWidgetKey } = await import('../project/project.repository.js')
      const project = await findProjectByWidgetKey(widgetKey)
      if (!project) throw new NotFoundError('Widget not found or disabled')

      const body = ChatRequestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      // Billing: register the widget session (dedup per cookie+month)
      const sessionToken = (req.body as { sessionToken?: string }).sessionToken
      trackWidgetSession(project, sessionToken)

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

      checkRateLimit(widgetKey, 'walkthrough')

      const { findProjectByWidgetKey } = await import('../project/project.repository.js')
      const project = await findProjectByWidgetKey(widgetKey)
      if (!project) throw new NotFoundError('Widget not found or disabled')
      if (!project.walkthroughEnabled) throw new NotFoundError('Walkthrough not enabled for this project')

      const body = WalkthroughRequestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const sessionToken = (req.body as { sessionToken?: string }).sessionToken
      trackWidgetSession(project, sessionToken)

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
