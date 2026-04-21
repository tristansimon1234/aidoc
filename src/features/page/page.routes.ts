import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { ValidationError, AppError } from '../../shared/middleware/error.middleware.js'
import { CreatePageSchema, UpdatePageSchema, ReorderSchema } from './page.schema.js'
import * as pageService from './page.service.js'
import { findDocByPageId } from '../documentation/documentation.repository.js'
import { getLatestRunByPageId } from '../run/run.service.js'

export const pageRouter = Router({ mergeParams: true })

const ProjectIdParam = z.object({ projectId: z.string().uuid() })
const PageParams = z.object({ projectId: z.string().uuid(), pageId: z.string().uuid() })

// Verify project ownership before any page operation
async function verifyProjectOwnership(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = (req as Request & { userId: string }).userId
    const projectId = req.params.projectId as string | undefined
    if (!projectId || !userId) {
      next(new AppError('Unauthorized', 'UNAUTHORIZED', 401))
      return
    }
    const { findProjectById } = await import('../project/project.repository.js')
    const project = await findProjectById(projectId)
    if (!project || project.userId !== userId) {
      next(new AppError('Project not found', 'PROJECT_NOT_FOUND', 404))
      return
    }
    next()
  } catch (err) {
    next(err)
  }
}

pageRouter.use(verifyProjectOwnership)

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

// Combined endpoint — returns page + latest run + doc in a single call
pageRouter.get('/:pageId/full', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = PageParams.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const [page, latestRun, doc] = await Promise.all([
        pageService.getPage(params.data.pageId),
        getLatestRunByPageId(params.data.pageId),
        findDocByPageId(params.data.pageId),
      ])

      // If no page-level doc, try run-level doc
      let finalDoc = doc
      if (!finalDoc && latestRun) {
        const { findDocByRunId } = await import('../documentation/documentation.repository.js')
        finalDoc = await findDocByRunId(latestRun.id)
      }

      res.status(200).json({ page, latestRun: latestRun ?? null, doc: finalDoc ?? null })
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

// Get the latest run for a page (for continue/resume)
pageRouter.get('/:pageId/run', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = PageParams.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const run = await getLatestRunByPageId(params.data.pageId)
      if (!run) {
        res.status(404).json({ error: 'No run found', code: 'RUN_NOT_FOUND' })
        return
      }
      res.status(200).json(run)
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
      const userId = (req as Request & { userId?: string }).userId ?? null
      const page = await pageService.updatePage(params.data.pageId, body.data, userId)
      res.status(200).json(page)
    } catch (err) {
      next(err)
    }
  })()
})

// Get the latest test report for a page (Try Doc analysis)
pageRouter.get('/:pageId/test-report', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = PageParams.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const { findLatestTestRunByPageId } = await import('../run/run.repository.js')
      const run = await findLatestTestRunByPageId(params.data.pageId)
      if (!run?.summaryJson?.tryDocReport) {
        res.status(404).json({ error: 'No test report found', code: 'TEST_REPORT_NOT_FOUND' })
        return
      }
      res.status(200).json(run.summaryJson.tryDocReport)
    } catch (err) {
      next(err)
    }
  })()
})

// Pre-flight verification before Try Doc test
pageRouter.post('/:pageId/preflight', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = PageParams.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const result = await pageService.runPreflight(params.data.pageId, params.data.projectId)
      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})

// Restore the previous version of a page (set by a doc regeneration).
// 404 when there's no snapshot to restore.
pageRouter.post('/:pageId/restore-previous', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = PageParams.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const restored = await pageService.restorePreviousContent(params.data.pageId)
      res.status(200).json(restored)
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
