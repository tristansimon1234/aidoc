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
// Uses .catch() and .default() to handle Gemini returning slightly off values

const priorityEnum = z.enum(['high', 'medium', 'low']).catch('medium')
const severityEnum = z.enum(['critical', 'major', 'minor']).catch('minor')
const severityHMLEnum = z.enum(['high', 'medium', 'low']).catch('medium')
const verdictEnum = z.enum(['pass', 'fail', 'partial']).catch('fail')
const stepStatusEnum = z.enum(['pass', 'fail', 'ambiguous']).catch('ambiguous')
const issueTypeEnum = z.enum(['doc', 'product']).nullable().catch(null)
const recTypeEnum = z.enum(['fix-doc', 'fix-product', 'improve-ux']).catch('fix-doc')
const insightCategoryEnum = z.enum(['friction', 'missing-feedback', 'unnecessary-step', 'doc-behavior-mismatch', 'implicit-assumption']).catch('friction')

export const TryDocReportSchema = z.object({
  summary: z.object({
    totalSteps: z.number().catch(0),
    passed: z.number().catch(0),
    failed: z.number().catch(0),
    ambiguous: z.number().catch(0),
    overallVerdict: verdictEnum,
  }),
  steps: z.array(z.object({
    stepIndex: z.number(),
    instruction: z.string(),
    action: z.string(),
    pageUrl: z.string().nullable().default(null),
    status: stepStatusEnum,
    issueType: issueTypeEnum,
    detail: z.string(),
    screenshotPath: z.string().nullable().default(null),
  })).default([]),
  failures: z.array(z.object({
    stepIndex: z.number(),
    issueType: z.enum(['doc', 'product']).catch('doc'),
    title: z.string(),
    description: z.string(),
    severity: severityEnum,
    suggestion: z.string(),
  })).default([]),
  docIssues: z.object({
    clarityScore: z.number().min(1).max(10).catch(5),
    missingSections: z.array(z.string()).default([]),
    ambiguousInstructions: z.array(z.string()).default([]),
    implicitAssumptions: z.array(z.string()).default([]),
  }).default({ clarityScore: 5, missingSections: [], ambiguousInstructions: [], implicitAssumptions: [] }),
  uxInsights: z.array(z.object({
    category: insightCategoryEnum,
    description: z.string(),
    stepIndex: z.number().nullable().default(null),
    severity: severityHMLEnum,
  })).default([]),
  recommendations: z.array(z.object({
    type: recTypeEnum,
    title: z.string(),
    description: z.string(),
    priority: priorityEnum,
  })).default([]),
  scores: z.object({
    docQuality: z.number().min(1).max(10).catch(5),
    testPassRate: z.number().min(1).max(10).catch(5),
    uxClarity: z.number().min(1).max(10).catch(5),
  }).default({ docQuality: 5, testPassRate: 5, uxClarity: 5 }),
})
