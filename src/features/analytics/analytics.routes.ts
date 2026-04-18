import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import { UuidParamSchema } from '../../shared/validation/schemas.js'
import { AnalyticsQuerySchema } from './analytics.schema.js'
import * as analyticsService from './analytics.service.js'

export const analyticsRouter = Router({ mergeParams: true })

function getUserId(req: Request): string {
  return (req as Request & { userId: string }).userId
}

// GET /api/projects/:projectId/analytics?period=7d|30d|90d
analyticsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = UuidParamSchema.safeParse({ id: req.params.projectId })
      if (!params.success) throw new ValidationError(params.error.flatten())

      const query = AnalyticsQuerySchema.safeParse(req.query)
      if (!query.success) throw new ValidationError(query.error.flatten())

      const report = await analyticsService.getReport(
        params.data.id,
        getUserId(req),
        query.data.period,
      )
      res.status(200).json(report)
    } catch (err) {
      next(err)
    }
  })()
})

// POST /api/projects/:projectId/analytics/recommendations?period=7d|30d|90d
// Explicit owner action — triggers the heavy Gemini pass. 5-min cooldown per (project, period).
analyticsRouter.post('/recommendations', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = UuidParamSchema.safeParse({ id: req.params.projectId })
      if (!params.success) throw new ValidationError(params.error.flatten())

      const query = AnalyticsQuerySchema.safeParse(req.query)
      if (!query.success) throw new ValidationError(query.error.flatten())

      const result = await analyticsService.getRecommendations(
        params.data.id,
        getUserId(req),
        query.data.period,
      )
      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})
