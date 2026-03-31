import { z } from 'zod'

export const UuidParamSchema = z.object({
  id: z.string().uuid('Must be a valid UUID'),
})

export type UuidParam = z.infer<typeof UuidParamSchema>
