import { z } from 'zod'
import { UuidParamSchema } from '../../shared/validation/schemas.js'

export const CreatePageSchema = z.object({
  title: z.string().min(1, 'Page title is required'),
  slug: z.string().min(1, 'Slug is required').regex(/^[a-z0-9-]+$/, 'Slug must be lowercase with hyphens'),
  parentId: z.string().uuid().optional(),
  startUrl: z.string().optional(),
  goal: z.string().optional(),
  sortOrder: z.number().int().optional(),
})

export const UpdatePageSchema = z.object({
  title: z.string().min(1).optional(),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  startUrl: z.string().optional(),
  goal: z.string().optional(),
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(['draft', 'exploring', 'published']).optional(),
  content: z.string().optional(),
  customPrompt: z.string().optional(),
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
