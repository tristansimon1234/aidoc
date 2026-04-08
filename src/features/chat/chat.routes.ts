import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import { ChatRequestSchema } from './chat.schema.js'
import * as chatService from './chat.service.js'
import { UuidParamSchema } from '../../shared/validation/schemas.js'

export const chatRouter = Router({ mergeParams: true })

// Chat with project documentation
chatRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = UuidParamSchema.safeParse({ id: req.params.projectId })
      if (!params.success) throw new ValidationError(params.error.flatten())

      const body = ChatRequestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const result = await chatService.chat(
        params.data.id,
        body.data.message,
        body.data.history,
      )

      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})

// Index/re-index all pages for a project
chatRouter.post('/index', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = UuidParamSchema.safeParse({ id: req.params.projectId })
      if (!params.success) throw new ValidationError(params.error.flatten())

      const count = await chatService.indexProject(params.data.id)
      res.status(200).json({ indexed: count })
    } catch (err) {
      next(err)
    }
  })()
})
