import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError, NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { Brand } from './brand.types.js'
import type { CreateBrandInput, UpdateBrandInput } from './brand.schema.js'

interface BrandRow {
  id: string
  user_id: string
  name: string
  logo_url: string | null
  logo_path: string | null
  accent_color: string
  bg_color: string
  text_color: string
  font_family: string
  website_url: string | null
  is_default: boolean
  created_at: string
  updated_at: string
}

function mapRow(row: BrandRow): Brand {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    logoUrl: row.logo_url,
    logoPath: row.logo_path,
    accentColor: row.accent_color,
    bgColor: row.bg_color,
    textColor: row.text_color,
    fontFamily: row.font_family,
    websiteUrl: row.website_url,
    isDefault: row.is_default,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export async function createBrand(userId: string, input: CreateBrandInput): Promise<Brand> {
  // First brand for the user becomes the default automatically — the user
  // shouldn't have to think about this on the onboarding screen.
  const existing = await listBrandsForUser(userId, 1)
  const isFirst = existing.length === 0
  const isDefault = input.isDefault ?? isFirst

  if (isDefault && !isFirst) {
    // Clear any prior default before inserting — the partial unique index
    // would reject two defaults per user otherwise. Done outside a
    // transaction; the worst-case race (two concurrent creates both with
    // isDefault: true) is resolved by the unique index throwing on the
    // second insert, which we surface as a 500.
    await supabase
      .from('brands')
      .update({ is_default: false })
      .eq('user_id', userId)
      .eq('is_default', true)
  }

  const { data, error } = await supabase
    .from('brands')
    .insert({
      user_id: userId,
      name: input.name,
      logo_url: input.logoUrl ?? null,
      logo_path: input.logoPath ?? null,
      accent_color: input.accentColor,
      bg_color: input.bgColor,
      text_color: input.textColor,
      font_family: input.fontFamily,
      website_url: input.websiteUrl ?? null,
      is_default: isDefault,
    })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapRow(data as BrandRow)
}

export async function findBrandById(id: string): Promise<Brand | null> {
  const { data, error } = await supabase
    .from('brands')
    .select('*')
    .eq('id', id)
    .single()
  if (error && error.code === 'PGRST116') return null
  if (error) throw new DatabaseError(error.message)
  return data ? mapRow(data as BrandRow) : null
}

export async function getBrandById(id: string): Promise<Brand> {
  const brand = await findBrandById(id)
  if (!brand) throw new NotFoundError('Brand')
  return brand
}

export async function findDefaultBrandForUser(userId: string): Promise<Brand | null> {
  const { data, error } = await supabase
    .from('brands')
    .select('*')
    .eq('user_id', userId)
    .eq('is_default', true)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return data ? mapRow(data as BrandRow) : null
}

export async function listBrandsForUser(userId: string, limit = 50): Promise<Brand[]> {
  const { data, error } = await supabase
    .from('brands')
    .select('*')
    .eq('user_id', userId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new DatabaseError(error.message)
  return (data as BrandRow[]).map(mapRow)
}

export async function updateBrand(id: string, input: UpdateBrandInput): Promise<Brand> {
  const row: Record<string, unknown> = {}
  if (input.name !== undefined) row.name = input.name
  if (input.logoUrl !== undefined) row.logo_url = input.logoUrl
  if (input.logoPath !== undefined) row.logo_path = input.logoPath
  if (input.accentColor !== undefined) row.accent_color = input.accentColor
  if (input.bgColor !== undefined) row.bg_color = input.bgColor
  if (input.textColor !== undefined) row.text_color = input.textColor
  if (input.fontFamily !== undefined) row.font_family = input.fontFamily
  if (input.websiteUrl !== undefined) row.website_url = input.websiteUrl
  if (input.isDefault !== undefined) row.is_default = input.isDefault

  // If flipping to default, clear the prior default first (same as create).
  if (input.isDefault === true) {
    const brand = await findBrandById(id)
    if (brand) {
      await supabase
        .from('brands')
        .update({ is_default: false })
        .eq('user_id', brand.userId)
        .eq('is_default', true)
        .neq('id', id)
    }
  }

  const { data, error } = await supabase
    .from('brands')
    .update(row)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapRow(data as BrandRow)
}

export async function deleteBrand(id: string): Promise<void> {
  // Foreign key on marketing_videos.brand_id is ON DELETE RESTRICT, so
  // Postgres will reject this if there are any videos linked. We surface
  // the underlying error via DatabaseError — the route layer translates
  // it to a 409 with a helpful message.
  const { error } = await supabase.from('brands').delete().eq('id', id)
  if (error) throw new DatabaseError(error.message)
}
