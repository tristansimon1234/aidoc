import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import { findProjectById } from '../project/project.repository.js'
import { findPublicPagesByProjectId } from './page.repository.js'

export const publicDocsRouter = Router()

// GET /docs/:projectId — public, no auth
publicDocsRouter.get('/:projectId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const project = await findProjectById(req.params.projectId as string)
      if (!project) throw new NotFoundError('Project not found')

      const pages = await findPublicPagesByProjectId(project.id)

      res.status(200).json({
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
          design: project.design,
        },
        pages: pages.map((p) => ({
          id: p.id,
          title: p.title,
          slug: p.slug,
          content: p.content,
          parentId: p.parentId,
          sortOrder: p.sortOrder,
        })),
      })
    } catch (err) {
      next(err)
    }
  })()
})
