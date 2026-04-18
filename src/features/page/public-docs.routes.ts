import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import { findProjectById } from '../project/project.repository.js'
import { findPublicPagesByProjectId } from './page.repository.js'
import { findLatestRunByPageId } from '../run/run.repository.js'
import { getPublicUrl } from '../../shared/db/storage.repository.js'

export const publicDocsRouter = Router()

// GET /docs/:projectId — public, no auth
publicDocsRouter.get('/:projectId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const project = await findProjectById(req.params.projectId as string)
      if (!project) throw new NotFoundError('Project not found')

      const pages = await findPublicPagesByProjectId(project.id)

      // For pages with showVideoOnPublic, include video/voiceover data
      const pagesWithVideo = await Promise.all(pages.map(async (p) => {
        const briefing = p.briefing as Record<string, unknown> | null
        const showVideo = briefing?.showVideoOnPublic === true

        let videoUrl: string | null = null
        let audioUrl: string | null = null

        if (showVideo) {
          const run = await findLatestRunByPageId(p.id)
          const summary = run?.summaryJson as Record<string, unknown> | null
          if (summary?.videoPath) {
            videoUrl = getPublicUrl('artifacts', summary.videoPath as string)
          }
          const voiceover = summary?.voiceover as Record<string, unknown> | null
          if (voiceover?.audioUrl) {
            audioUrl = voiceover.audioUrl as string
          } else if (voiceover?.audioPath) {
            audioUrl = getPublicUrl('artifacts', voiceover.audioPath as string)
          }
        }

        return {
          id: p.id,
          title: p.title,
          slug: p.slug,
          content: p.content,
          parentId: p.parentId,
          sortOrder: p.sortOrder,
          videoUrl,
          audioUrl,
        }
      }))

      const widget = project.publicDocsChatEnabled && project.widgetEnabled && project.widgetApiKey
        ? {
            apiKey: project.widgetApiKey,
            position: project.design?.widgetPosition ?? 'right',
            greeting: project.design?.widgetGreeting ?? '',
          }
        : null

      res.status(200).json({
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
          design: project.design,
        },
        widget,
        pages: pagesWithVideo,
      })
    } catch (err) {
      next(err)
    }
  })()
})
