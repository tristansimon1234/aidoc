import { z } from 'zod'
import { UuidParamSchema } from '../../shared/validation/schemas.js'

export const CreateRunSchema = z.object({
  featureName: z.string().min(1, 'Feature name is required'),
  startUrl: z.string().url('Must be a valid URL'),
  goal: z.string().min(1, 'Goal is required'),
})

export type CreateRunInput = z.infer<typeof CreateRunSchema>

export const RunIdParamSchema = UuidParamSchema
