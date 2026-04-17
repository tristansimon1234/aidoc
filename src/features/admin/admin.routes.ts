import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import * as adminService from './admin.service.js'

export const adminRouter = Router()

function currentPeriodMonth(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
}

function validateMonth(value: string): string {
  // Accepts 'YYYY-MM' or 'YYYY-MM-01'
  const m = /^(\d{4})-(\d{2})(?:-01)?$/.exec(value)
  if (!m) throw new ValidationError('month must be YYYY-MM or YYYY-MM-01')
  return `${m[1]!}-${m[2]!}-01`
}

adminRouter.get('/usage', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const monthRaw = typeof req.query.month === 'string' ? req.query.month : null
      const periodMonth = monthRaw ? validateMonth(monthRaw) : currentPeriodMonth()
      const report = await adminService.getUsageReport(periodMonth)
      res.status(200).json(report)
    } catch (err) {
      next(err)
    }
  })()
})
