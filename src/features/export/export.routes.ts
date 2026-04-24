import { Router, raw } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { AppError, ValidationError } from '../../shared/middleware/error.middleware.js'
import { buildPageZip, buildProjectZip } from './export.service.js'
import { importPageZip, importProjectZip } from './import.service.js'

/** Hard cap on uploaded archives. 200 MB matches the video upload cap —
 *  enough for a decent-size project (videos + screenshots + voice-over) while
 *  keeping serverless memory usage predictable. */
const MAX_ZIP_BYTES = 200 * 1024 * 1024

/** Mounted under `/projects/:projectId` so the ownership guard below can read
 *  `req.params.projectId` populated by the parent matcher. */
export const exportRouter = Router({ mergeParams: true })

const PageIdParam = z.object({ pageId: z.string().uuid() })

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

exportRouter.use(verifyProjectOwnership)

// --- Export ---

exportRouter.get('/export', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = req.params.projectId as string
      const { buffer, filename } = await buildProjectZip(projectId)
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.setHeader('Content-Length', String(buffer.length))
      res.status(200).end(buffer)
    } catch (err) {
      next(err)
    }
  })()
})

exportRouter.get('/pages/:pageId/export', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = PageIdParam.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const { buffer, filename } = await buildPageZip(params.data.pageId)
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.setHeader('Content-Length', String(buffer.length))
      res.status(200).end(buffer)
    } catch (err) {
      next(err)
    }
  })()
})

// --- Import ---

// Dedicated raw body parser — the app-level `express.json()` would otherwise
// try to parse the ZIP as JSON and fail. Scoped to these POSTs only.
const zipBody = raw({ type: 'application/zip', limit: MAX_ZIP_BYTES })

exportRouter.post('/import', zipBody, (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = req.params.projectId as string
      const buffer = Buffer.isBuffer(req.body) ? req.body : null
      if (!buffer || buffer.length === 0) {
        throw new AppError('Empty body — send the ZIP with Content-Type: application/zip', 'EMPTY_IMPORT', 400)
      }
      const result = await importProjectZip(projectId, buffer)
      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})

const PageImportQuery = z.object({
  parentId: z.string().uuid().optional(),
})

exportRouter.post('/pages/import', zipBody, (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = req.params.projectId as string
      const q = PageImportQuery.safeParse(req.query)
      if (!q.success) throw new ValidationError(q.error.flatten())
      const buffer = Buffer.isBuffer(req.body) ? req.body : null
      if (!buffer || buffer.length === 0) {
        throw new AppError('Empty body — send the ZIP with Content-Type: application/zip', 'EMPTY_IMPORT', 400)
      }
      const result = await importPageZip(projectId, buffer, q.data.parentId ?? null)
      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})
