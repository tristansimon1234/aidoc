import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError, NotFoundError } from '../../shared/middleware/error.middleware.js'
import { ChatRequestSchema } from './chat.schema.js'
import * as chatService from './chat.service.js'

export const widgetRouter = Router()

// Public chat endpoint — API key auth, no Supabase JWT
widgetRouter.post('/:widgetKey/chat', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const widgetKey = req.params.widgetKey as string
      if (!widgetKey) throw new ValidationError('Widget key is required')

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

      res.status(200).json({
        projectName: project.name,
        enabled: project.widgetEnabled,
      })
    } catch (err) {
      next(err)
    }
  })()
})
