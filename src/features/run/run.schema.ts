import { z } from 'zod'
import { UuidParamSchema } from '../../shared/validation/schemas.js'

export const CreateRunSchema = z.object({
  featureName: z.string().min(1, 'Feature name is required'),
  startUrl: z.string().url('Must be a valid URL').or(z.literal('')).default(''),
  goal: z.string().min(1, 'Goal is required'),
  docPageId: z.string().uuid().optional(),
})

export type CreateRunInput = z.infer<typeof CreateRunSchema>

export const RunIdParamSchema = UuidParamSchema

// --- Try Doc Report Zod schema (for Gemini output validation) ---

export const TryDocReportSchema = z.object({
  summary: z.object({
    totalSteps: z.number(),
    passed: z.number(),
    failed: z.number(),
    ambiguous: z.number(),
    overallVerdict: z.enum(['pass', 'fail', 'partial']),
  }),
  steps: z.array(z.object({
    stepIndex: z.number(),
    instruction: z.string(),
    action: z.string(),
    pageUrl: z.string().nullable().default(null),
    status: z.enum(['pass', 'fail', 'ambiguous']),
    issueType: z.enum(['doc', 'product']).nullable().default(null),
    detail: z.string(),
    screenshotPath: z.string().nullable().default(null),
  })),
  failures: z.array(z.object({
    stepIndex: z.number(),
    issueType: z.enum(['doc', 'product']),
    title: z.string(),
    description: z.string(),
    severity: z.enum(['critical', 'major', 'minor']),
    suggestion: z.string(),
  })),
  docIssues: z.object({
    clarityScore: z.number().min(1).max(10),
    missingSections: z.array(z.string()),
    ambiguousInstructions: z.array(z.string()),
    implicitAssumptions: z.array(z.string()),
  }),
  uxInsights: z.array(z.object({
    category: z.enum(['friction', 'missing-feedback', 'unnecessary-step', 'doc-behavior-mismatch', 'implicit-assumption']),
    description: z.string(),
    stepIndex: z.number().nullable().default(null),
    severity: z.enum(['high', 'medium', 'low']),
  })),
  recommendations: z.array(z.object({
    type: z.enum(['fix-doc', 'fix-product', 'improve-ux']),
    title: z.string(),
    description: z.string(),
    priority: z.enum(['high', 'medium', 'low']),
  })),
  scores: z.object({
    docQuality: z.number().min(1).max(10),
    testPassRate: z.number().min(1).max(10),
    uxClarity: z.number().min(1).max(10),
  }),
})
