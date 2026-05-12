import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { AppError, ValidationError } from '../../shared/middleware/error.middleware.js'
import { CreateTabSchema, DeleteTabBodySchema, ReorderTabsSchema, UpdateTabSchema } from './tab.schema.js'
import * as tabService from './tab.service.js'

export const tabRouter = Router({ mergeParams: true })

const ProjectIdParam = z.object({ projectId: z.string().uuid() })
const ProjectTabParams = z.object({ projectId: z.string().uuid(), tabId: z.string().uuid() })

async function verifyProjectAccess(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = (req as Request & { userId: string }).userId
    const projectId = req.params.projectId as string | undefined
    if (!projectId || !userId) {
      next(new AppError('Unauthorized', 'UNAUTHORIZED', 401))
      return
    }
    const { assertProjectAccess } = await import('../project/project.service.js')
    try {
      await assertProjectAccess(projectId, userId)
    } catch {
      next(new AppError('Project not found', 'PROJECT_NOT_FOUND', 404))
      return
    }
    next()
  } catch (err) {
    next(err)
  }
}

tabRouter.use(verifyProjectAccess)

tabRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParam.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const tabs = await tabService.listTabs(params.data.projectId)
      res.status(200).json(tabs)
    } catch (err) {
      next(err)
    }
  })()
})

tabRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParam.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = CreateTabSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())
      const tab = await tabService.createTab(params.data.projectId, body.data)
      res.status(201).json(tab)
    } catch (err) {
      next(err)
    }
  })()
})

tabRouter.post('/reorder', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParam.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = ReorderTabsSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())
      await tabService.reorderTabs(params.data.projectId, body.data.tabIds)
      res.status(200).json({ success: true })
    } catch (err) {
      next(err)
    }
  })()
})

tabRouter.patch('/:tabId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectTabParams.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = UpdateTabSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())
      const tab = await tabService.updateTab(params.data.projectId, params.data.tabId, body.data)
      res.status(200).json(tab)
    } catch (err) {
      next(err)
    }
  })()
})

tabRouter.delete('/:tabId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectTabParams.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      // Body is optional — empty tabs delete without one. Schema returns
      // `undefined` if absent, so guard before unwrapping.
      const body = DeleteTabBodySchema.safeParse(req.body ?? {})
      if (!body.success) throw new ValidationError(body.error.flatten())
      await tabService.deleteTab(params.data.projectId, params.data.tabId, body.data ?? {})
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })()
})
