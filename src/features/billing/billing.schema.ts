import { z } from 'zod'

export const PlanIdSchema = z.enum(['free', 'startup', 'growth', 'business'])

export const SelectPlanSchema = z.object({
  planId: PlanIdSchema,
})
