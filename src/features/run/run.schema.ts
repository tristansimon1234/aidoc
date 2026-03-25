import { z } from 'zod'

export const CreateRunSchema = z.object({
  featureName: z.string().min(1, 'Feature name is required'),
  startUrl: z.string().url('Must be a valid URL'),
  goal: z.string().min(1, 'Goal is required'),
})

export type CreateRunInput = z.infer<typeof CreateRunSchema>

export const RunIdParamSchema = z.object({
  id: z.string().uuid('Must be a valid UUID'),
})
