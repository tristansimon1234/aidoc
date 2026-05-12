import { z } from 'zod'
import { UuidParamSchema } from '../../shared/validation/schemas.js'

export const CreatePageSchema = z.object({
  title: z.string().min(1, 'Page title is required'),
  slug: z.string().min(1, 'Slug is required').regex(/^[a-z0-9-]+$/, 'Slug must be lowercase with hyphens'),
  parentId: z.string().uuid().optional(),
  // When omitted, the service resolves the project's default "main" tab —
  // existing API callers from before the tabs feature keep working.
  tabId: z.string().uuid().optional(),
  startUrl: z.string().optional(),
  goal: z.string().optional(),
  sortOrder: z.number().int().optional(),
})

const PageResourceSchema = z.object({
  type: z.enum(['url', 'credential', 'endpoint', 'file', 'note']),
  label: z.string().min(1),
  value: z.string().min(1),
})

const PageBriefingSchema = z.object({
  objective: z.string(),
  knowledge: z.string(),
  resources: z.array(PageResourceSchema),
})

export const UpdatePageSchema = z.object({
  title: z.string().min(1).optional(),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  startUrl: z.string().optional(),
  goal: z.string().optional(),
  parentId: z.string().uuid().nullable().optional(),
  // Move the page to a different tab. Skipped on most updates.
  tabId: z.string().uuid().optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(['draft', 'exploring', 'published']).optional(),
  content: z.string().optional(),
  // BlockNote document JSON — validated shape-loosely as array; the editor
  // owns the schema so we don't need to replicate it here.
  contentBlocks: z.array(z.unknown()).optional(),
  customPrompt: z.string().optional(),
  briefing: PageBriefingSchema.optional(),
  isPublic: z.boolean().optional(),
})

export const ReorderSchema = z.array(z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  sortOrder: z.number().int(),
}))

export const PageIdParamSchema = UuidParamSchema
export const ProjectPageParamsSchema = z.object({
  projectId: z.string().uuid(),
  pageId: z.string().uuid(),
})

// --- Pre-flight verification schemas ---

// What Gemini returns: requirements analysis of the documentation
export const DocRequirementsAnalysisSchema = z.object({
  testPlan: z.string(),
  estimatedSteps: z.number(),
  requirements: z.array(z.object({
    category: z.enum(['file', 'prerequisite']),
    label: z.string(),
    reason: z.string(),
  })),
})
