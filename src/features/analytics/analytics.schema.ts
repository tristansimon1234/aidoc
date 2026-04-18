import { z } from 'zod'

export const AnalyticsQuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d']).default('30d'),
})

const severity = z.enum(['high', 'medium', 'low'])

/** Shape returned by the on-demand `POST /analytics/recommendations` endpoint. */
export const AiRecommendationsSchema = z.object({
  summary: z.string().min(1),
  items: z.array(z.object({
    type: z.enum(['content', 'product', 'ux']),
    title: z.string().min(1),
    description: z.string().min(1),
    priority: severity,
  })).default([]),
})

export const PageViewPingSchema = z.object({
  pageSlug: z.string().min(1).max(200),
  sessionToken: z.string().min(8).max(128),
})

export const ViewPageIdParamSchema = z.object({
  projectId: z.string().uuid(),
})
