import { randomUUID } from 'node:crypto'
import { Router, raw } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { AppError, ValidationError } from '../../shared/middleware/error.middleware.js'
import { buildPageZip, buildProjectZip } from './export.service.js'
import { importPageZip, importProjectZip } from './import.service.js'
import { downloadFromStorage, getSignedUrl, uploadToStorage } from '../../shared/db/storage.repository.js'

/** Hard cap on uploaded archives. 200 MB matches the video upload cap —
 *  enough for a decent-size project (videos + screenshots + voice-over) while
 *  keeping serverless memory usage predictable. */
const MAX_ZIP_BYTES = 200 * 1024 * 1024

/** Mounted under `/projects/:projectId` so the ownership guard below can read
 *  `req.params.projectId` populated by the parent matcher. */
export const exportRouter = Router({ mergeParams: true })

const PageIdParam = z.object({ pageId: z.string().uuid() })

async function verifyProjectAccess(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = (req as Request & { userId: string }).userId
    const projectId = req.params.projectId as string | undefined
    if (!projectId || !userId) {
      next(new AppError('Unauthorized', 'UNAUTHORIZED', 401))
      return
    }
    // Team-scoped access check. Throws 403/404; collapse both to 404 so
    // non-members can't enumerate project ids across teams. Matches the
    // pattern in page.routes and analytics.service.
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

exportRouter.use(verifyProjectAccess)

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

// --- Async export (for big projects) ---
//
// The sync `/export` route above streams the ZIP back in the response body —
// fine for small projects, but a 100 MB download through the serverless
// function frequently times out on Vercel (and buffers the whole thing in
// memory on both ends). The async variant instead:
//
//  1. POST /export-async → writes a "pending" status file to storage, kicks
//     off the zip build without awaiting, responds immediately with `exportId`.
//  2. Background task finishes building, uploads the ZIP to storage, flips
//     the status file to "ready" with the object path.
//  3. GET /export-async/:exportId → polls the status file; when ready, returns
//     a short-lived signed URL pointing at the ZIP. The browser downloads
//     directly from Supabase — the serverless function never streams bytes.
//
// Both the status JSON and the ZIP are written under `exports/<exportId>.*`
// in the `artifacts` bucket. They stick around (no TTL) so a user who
// refreshed the tab can still retrieve a recent export by ID.
const EXPORT_STATUS_CONTENT_TYPE = 'application/json'

interface ExportStatusReady {
  status: 'ready'
  zipPath: string
  filename: string
  size: number
}

interface ExportStatusFailed {
  status: 'failed'
  error: string
}

interface ExportStatusPending {
  status: 'pending'
  kind: 'project' | 'page'
  createdAt: string
}

type ExportStatus = ExportStatusReady | ExportStatusFailed | ExportStatusPending

async function writeStatus(exportId: string, status: ExportStatus): Promise<void> {
  await uploadToStorage(
    'artifacts',
    `exports/${exportId}.json`,
    Buffer.from(JSON.stringify(status)),
    EXPORT_STATUS_CONTENT_TYPE,
  )
}

async function runAsyncExport(
  exportId: string,
  kind: 'project' | 'page',
  build: () => Promise<{ buffer: Buffer; filename: string }>,
): Promise<void> {
  try {
    const { buffer, filename } = await build()
    const zipPath = `exports/${exportId}.zip`
    await uploadToStorage('artifacts', zipPath, buffer, 'application/zip')
    await writeStatus(exportId, { status: 'ready', zipPath, filename, size: buffer.length })
  } catch (err) {
    await writeStatus(exportId, { status: 'failed', error: (err as Error).message }).catch(() => {
      console.error(`[export-async ${exportId}] failed to write error status`)
    })
    console.error(`[export-async ${exportId}] build failed:`, err)
  }
  void kind // kept for future per-kind metrics; silences unused-var lint without changing the call site
}

exportRouter.post('/export-async', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = req.params.projectId as string
      const exportId = randomUUID()
      await writeStatus(exportId, { status: 'pending', kind: 'project', createdAt: new Date().toISOString() })
      // Fire-and-forget. On Vercel the Lambda keeps running until all pending
      // async work completes, capped at maxDuration (300s) — enough for any
      // project that fits under the 200 MB ZIP cap.
      void runAsyncExport(exportId, 'project', () => buildProjectZip(projectId))
      res.status(202).json({ exportId })
    } catch (err) {
      next(err)
    }
  })()
})

exportRouter.post('/pages/:pageId/export-async', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = PageIdParam.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const exportId = randomUUID()
      await writeStatus(exportId, { status: 'pending', kind: 'page', createdAt: new Date().toISOString() })
      void runAsyncExport(exportId, 'page', () => buildPageZip(params.data.pageId))
      res.status(202).json({ exportId })
    } catch (err) {
      next(err)
    }
  })()
})

const ExportIdParam = z.object({ exportId: z.string().uuid() })

exportRouter.get('/export-async/:exportId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ExportIdParam.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const statusBuf = await downloadFromStorage('artifacts', `exports/${params.data.exportId}.json`)
      if (!statusBuf) {
        throw new AppError('Export not found or expired', 'EXPORT_NOT_FOUND', 404)
      }
      const status = JSON.parse(statusBuf.toString()) as ExportStatus
      if (status.status === 'ready') {
        // Short-lived link — the browser downloads right after the poll
        // returns, no need to keep this URL around for hours.
        const downloadUrl = await getSignedUrl('artifacts', status.zipPath, 60 * 15)
        res.status(200).json({ status: 'ready', filename: status.filename, size: status.size, downloadUrl })
        return
      }
      res.status(200).json(status)
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
