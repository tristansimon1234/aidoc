import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { AppError, ValidationError } from '../../shared/middleware/error.middleware.js'
import { UuidParamSchema } from '../../shared/validation/schemas.js'
import * as docService from './documentation.service.js'
import { assertRunAccess } from '../run/run.service.js'

export const documentationRouter = Router()

documentationRouter.get('/:id/doc', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = UuidParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const userId = (req as Request & { userId?: string }).userId
      if (!userId) throw new AppError('Unauthorized', 'UNAUTHORIZED', 401)
      await assertRunAccess(params.data.id, userId)
      const doc = await docService.getDocByRunId(params.data.id)
      res.status(200).json(doc)
    } catch (err) {
      next(err)
    }
  })()
})
