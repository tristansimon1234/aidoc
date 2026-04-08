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
        body.data.userContext,
      )

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
      const params = UuidParamSchema.safeParse({ id: req.params.projectId })
      if (!params.success) throw new ValidationError(params.error.flatten())

      const body = req.body as { force?: boolean }
      const { hasEmbeddings } = await import('./chat.repository.js')
      const exists = await hasEmbeddings(params.data.id)

      // Skip re-indexing if embeddings exist and not forced
      if (exists && !body.force) {
        res.status(200).json({ indexed: 1, cached: true })
        return
      }

      const count = await chatService.indexProject(params.data.id)
      res.status(200).json({ indexed: count, cached: false })
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
      const params = UuidParamSchema.safeParse({ id: req.params.projectId })
      if (!params.success) throw new ValidationError(params.error.flatten())

      const projectId = params.data.id
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
