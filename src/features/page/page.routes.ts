import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import { CreatePageSchema, UpdatePageSchema, ReorderSchema } from './page.schema.js'
import * as pageService from './page.service.js'
import { findDocByPageId } from '../documentation/documentation.repository.js'

export const pageRouter = Router({ mergeParams: true })

const ProjectIdParam = z.object({ projectId: z.string().uuid() })
const PageParams = z.object({ projectId: z.string().uuid(), pageId: z.string().uuid() })

pageRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParam.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const tree = await pageService.getPageTree(params.data.projectId)
      res.status(200).json(tree)
    } catch (err) {
      next(err)
    }
  })()
})

pageRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParam.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = CreatePageSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())
      const page = await pageService.createPage({
        ...body.data,
        projectId: params.data.projectId,
      })
      res.status(201).json(page)
    } catch (err) {
      next(err)
    }
  })()
})

// Auto-generate documentation structure — agent scans site and creates pages
pageRouter.post('/auto-generate', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParam.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const pages = await pageService.autoGenerateStructure(params.data.projectId)
      res.status(201).json(pages)
    } catch (err) {
      next(err)
    }
  })()
})

pageRouter.put('/reorder', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const body = ReorderSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())
      await pageService.reorderPages(body.data)
      res.status(200).json({ success: true })
    } catch (err) {
      next(err)
    }
  })()
})

pageRouter.get('/:pageId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = PageParams.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const page = await pageService.getPage(params.data.pageId)
      res.status(200).json(page)
    } catch (err) {
      next(err)
    }
  })()
})

// Get the generated doc for a page
pageRouter.get('/:pageId/doc', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = PageParams.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const doc = await findDocByPageId(params.data.pageId)
      if (!doc) {
        res.status(404).json({ error: 'No documentation generated yet', code: 'DOC_NOT_FOUND' })
        return
      }
      res.status(200).json(doc)
    } catch (err) {
      next(err)
    }
  })()
})

pageRouter.put('/:pageId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = PageParams.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = UpdatePageSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())
      const page = await pageService.updatePage(params.data.pageId, body.data)
      res.status(200).json(page)
    } catch (err) {
      next(err)
    }
  })()
})

pageRouter.delete('/:pageId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = PageParams.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      await pageService.deletePage(params.data.pageId)
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })()
})
