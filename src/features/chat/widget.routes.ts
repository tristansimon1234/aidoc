import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError, NotFoundError, AppError } from '../../shared/middleware/error.middleware.js'
import { ChatRequestSchema } from './chat.schema.js'
import * as chatService from './chat.service.js'

export const widgetRouter = Router()

// --- In-memory rate limiter per API key ---
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 30 // max requests per window
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute

function checkRateLimit(key: string): void {
  const now = Date.now()
  const entry = rateLimitMap.get(key)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return
  }

  entry.count++
  if (entry.count > RATE_LIMIT_MAX) {
    throw new AppError('Rate limit exceeded. Try again in a minute.', 'RATE_LIMITED', 429)
  }
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key)
  }
}, 300_000)

// Public chat endpoint — API key auth, no Supabase JWT
widgetRouter.post('/:widgetKey/chat', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const widgetKey = req.params.widgetKey as string
      if (!widgetKey) throw new ValidationError('Widget key is required')

      checkRateLimit(widgetKey)

      // Validate API key → find project
      const { findProjectByWidgetKey } = await import('../project/project.repository.js')
      const project = await findProjectByWidgetKey(widgetKey)
      if (!project) throw new NotFoundError('Widget not found or disabled')

      const body = ChatRequestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const result = await chatService.chat(
        project.id,
        body.data.message,
        body.data.history,
        body.data.userContext,
      )

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

      // Fetch dynamic suggestions
      const suggestions = await chatService.getSuggestions(project.id)

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
