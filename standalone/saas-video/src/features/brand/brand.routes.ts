import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError, NotFoundError } from '../../shared/middleware/error.middleware.js'
import { getUserId } from '../../shared/middleware/auth.middleware.js'
import { BrandIdParamSchema, CreateBrandSchema, UpdateBrandSchema } from './brand.schema.js'
import {
  createBrand,
  deleteBrand,
  findBrandById,
  listBrandsForUser,
  updateBrand,
} from './brand.repository.js'

export const brandRouter = Router()

function ensureOwnership(brand: { userId: string }, userId: string): void {
  if (brand.userId !== userId) {
    // Hide brands owned by other users behind a 404 (don't leak existence
    // via 403 vs 404 distinction).
    throw new NotFoundError('Brand')
  }
}

brandRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const brands = await listBrandsForUser(userId)
      res.status(200).json({ items: brands })
    } catch (err) { next(err) }
  })()
})

brandRouter.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const body = CreateBrandSchema.safeParse(req.body ?? {})
      if (!body.success) throw new ValidationError(body.error.flatten())
      const brand = await createBrand(userId, body.data)
      res.status(201).json(brand)
    } catch (err) { next(err) }
  })()
})

brandRouter.get('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const params = BrandIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const brand = await findBrandById(params.data.id)
      if (!brand) throw new NotFoundError('Brand')
      ensureOwnership(brand, userId)
      res.status(200).json(brand)
    } catch (err) { next(err) }
  })()
})

brandRouter.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const params = BrandIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = UpdateBrandSchema.safeParse(req.body ?? {})
      if (!body.success) throw new ValidationError(body.error.flatten())

      const existing = await findBrandById(params.data.id)
      if (!existing) throw new NotFoundError('Brand')
      ensureOwnership(existing, userId)

      const updated = await updateBrand(params.data.id, body.data)
      res.status(200).json(updated)
    } catch (err) { next(err) }
  })()
})

brandRouter.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const userId = getUserId(req)
      const params = BrandIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const existing = await findBrandById(params.data.id)
      if (!existing) throw new NotFoundError('Brand')
      ensureOwnership(existing, userId)

      await deleteBrand(params.data.id)
      res.status(204).end()
    } catch (err) { next(err) }
  })()
})
