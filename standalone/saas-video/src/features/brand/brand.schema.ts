import { z } from 'zod'
import { LenientHexColorSchema } from '../../shared/design/colors.js'
import { isAllowedFontFamily, DEFAULT_FONT } from '../../shared/design/fonts.js'

const FontFamilySchema = z.preprocess(
  (v) => (typeof v === 'string' && isAllowedFontFamily(v) ? v : DEFAULT_FONT.cssValue),
  z.string(),
)

export const CreateBrandSchema = z.object({
  name: z.string().min(1).max(80),
  logoUrl: z.string().url().nullable().optional(),
  logoPath: z.string().nullable().optional(),
  accentColor: LenientHexColorSchema.default('#5B5BD6'),
  bgColor: LenientHexColorSchema.default('#0B0B0F'),
  textColor: LenientHexColorSchema.default('#F5F5F7'),
  fontFamily: FontFamilySchema.default(DEFAULT_FONT.cssValue),
  websiteUrl: z.string().url().nullable().optional(),
  isDefault: z.boolean().optional(),
})

export const UpdateBrandSchema = CreateBrandSchema.partial()

export const BrandIdParamSchema = z.object({
  id: z.string().uuid(),
})

export type CreateBrandInput = z.infer<typeof CreateBrandSchema>
export type UpdateBrandInput = z.infer<typeof UpdateBrandSchema>
