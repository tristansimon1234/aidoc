import { z } from 'zod'

export const UpdateProfileSchema = z.object({
  fullName: z.string().max(120).nullable().optional(),
})
