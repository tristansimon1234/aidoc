import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import * as adminService from './admin.service.js'
import * as allowlistRepo from './allowlist.repository.js'
import { AddAllowedEmailSchema } from './allowlist.schema.js'

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

// Email allowlist — controls who can sign up while Doclee is in the
// design-partner phase. A BEFORE INSERT trigger on auth.users enforces this
// at the DB level (see migration 20260511000000_add_email_allowlist.sql); the
// routes here are only the admin CRUD surface.
adminRouter.get('/allowlist', (_req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const items = await allowlistRepo.listAllowedEmails()
      res.status(200).json({ items })
    } catch (err) {
      next(err)
    }
  })()
})

adminRouter.post('/allowlist', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const parsed = AddAllowedEmailSchema.safeParse(req.body)
      if (!parsed.success) throw new ValidationError(parsed.error.flatten())
      const userId = (req as Request & { userId: string }).userId
      const row = await allowlistRepo.addAllowedEmail(
        parsed.data.email,
        parsed.data.note ?? null,
        userId,
      )
      res.status(201).json(row)
    } catch (err) {
      next(err)
    }
  })()
})

adminRouter.delete('/allowlist/:email', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const email = decodeURIComponent(req.params.email ?? '').trim().toLowerCase()
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ValidationError('email param required')
      }
      await allowlistRepo.removeAllowedEmail(email)
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })()
})
