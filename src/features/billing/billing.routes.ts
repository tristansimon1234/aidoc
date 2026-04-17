import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import { SelectPlanSchema } from './billing.schema.js'
import * as billingService from './billing.service.js'

export const billingRouter = Router()

function getUserId(req: Request): string {
  return (req as Request & { userId: string }).userId
}

billingRouter.get('/plans', (_req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const plans = await billingService.listPlans()
      res.status(200).json(plans)
    } catch (err) {
      next(err)
    }
  })()
})

billingRouter.get('/summary', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const summary = await billingService.getSummary(getUserId(req))
      res.status(200).json(summary)
    } catch (err) {
      next(err)
    }
  })()
})

// Temporary plan selection without Stripe.
// TODO(stripe): replace with POST /billing/checkout that returns a
// Stripe Checkout Session URL for paid plans. The 'free' (downgrade)
// path keeps this direct mutation.
billingRouter.post('/subscription/select', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const parsed = SelectPlanSchema.safeParse(req.body)
      if (!parsed.success) throw new ValidationError(parsed.error.flatten())
      const summary = await billingService.selectPlan(getUserId(req), parsed.data.planId)
      res.status(200).json(summary)
    } catch (err) {
      next(err)
    }
  })()
})
