/**
 * A user's brand identity — logo, colors, font, website. One user can have
 * many brands (one per product, client, or variant); exactly one is the
 * default surfaced first in pickers and used when no brand_id is provided
 * on video creation.
 */
export interface Brand {
  id: string
  userId: string
  name: string
  logoUrl: string | null
  logoPath: string | null
  accentColor: string
  bgColor: string
  textColor: string
  fontFamily: string
  websiteUrl: string | null
  isDefault: boolean
  createdAt: Date
  updatedAt: Date
}
