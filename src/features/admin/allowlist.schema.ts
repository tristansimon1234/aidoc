import { z } from 'zod'

export const AddAllowedEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  note: z.string().trim().max(500).optional().nullable(),
})

export type AddAllowedEmailInput = z.infer<typeof AddAllowedEmailSchema>
