import type { Request, Response, NextFunction } from 'express'
import { Sentry } from '../observability/sentry.js'

export interface ApiError {
  error: string
  code: string
  details?: unknown
}

export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, `${resource.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`, 404)
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown) {
    super('Validation failed', 'VALIDATION_ERROR', 422, details)
  }
}

export class DatabaseError extends AppError {
  constructor(message: string) {
    super(message, 'DATABASE_ERROR', 500)
  }
}

export class QuotaExceededError extends AppError {
  constructor(message = 'No credits remaining. Buy a credit pack to keep generating.') {
    super(message, 'INSUFFICIENT_CREDITS', 402)
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      console.error(`[${err.code}] ${err.message}\n${err.stack ?? ''}`)
      Sentry.withScope((scope) => {
        scope.setTag('error_code', err.code)
        scope.setTag('path', req.path)
        Sentry.captureException(err)
      })
    }
    const body: ApiError = {
      error: err.message,
      code: err.code,
      ...(err.details ? { details: err.details } : {}),
    }
    res.status(err.statusCode).json(body)
    return
  }

  console.error('Unhandled error:', err)
  Sentry.withScope((scope) => {
    scope.setTag('path', req.path)
    Sentry.captureException(err)
  })
  const body: ApiError = { error: 'Internal server error', code: 'INTERNAL_ERROR' }
  res.status(500).json(body)
}
