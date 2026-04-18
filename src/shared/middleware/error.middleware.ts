import type { Request, Response, NextFunction } from 'express'

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

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    // 5xx responses still need a stack trace in the server log so we can
    // diagnose them after the fact — AppError used to swallow those silently.
    if (err.statusCode >= 500) {
      console.error(`[${err.code}] ${err.message}\n${err.stack ?? ''}`)
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
  const body: ApiError = { error: 'Internal server error', code: 'INTERNAL_ERROR' }
  res.status(500).json(body)
}
