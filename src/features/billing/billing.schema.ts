import { z } from 'zod'

export const PlanIdSchema = z.enum(['free', 'founder', 'team', 'agency'])

export const SelectPlanSchema = z.object({
  planId: PlanIdSchema,
})
