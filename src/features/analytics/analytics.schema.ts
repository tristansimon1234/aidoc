import { z } from 'zod'

export const AnalyticsQuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d']).default('30d'),
})

const severity = z.enum(['high', 'medium', 'low'])

export const AiInsightsSchema = z.object({
  overallSentiment: z.object({
    score: z.enum(['positive', 'neutral', 'negative', 'mixed']),
    summary: z.string().min(1),
  }),
  painPoints: z.array(z.object({
    topic: z.string().min(1),
    frequency: z.number().int().nonnegative(),
    severity,
    examples: z.array(z.string()).default([]),
  })).default([]),
  frustrationSignals: z.array(z.object({
    excerpt: z.string().min(1),
    reason: z.string().min(1),
    severity,
  })).default([]),
  contentGaps: z.array(z.object({
    question: z.string().min(1),
    askedCount: z.number().int().nonnegative(),
    suggestedPage: z.string().nullable().default(null),
  })).default([]),
  recommendations: z.array(z.object({
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
