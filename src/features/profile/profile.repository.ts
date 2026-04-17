import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { Profile, UpdateProfileInput } from './profile.types.js'

interface ProfileRow {
  id: string
  email: string | null
  full_name: string | null
  preferred_language: string
  stripe_customer_id: string | null
  created_at: string
  updated_at: string
}

function mapToProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    preferredLanguage: row.preferred_language,
    stripeCustomerId: row.stripe_customer_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export async function findProfileById(id: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', id).single()
  if (error && error.code === 'PGRST116') return null
  if (error) throw new DatabaseError(error.message)
  return data ? mapToProfile(data as ProfileRow) : null
}

// If the DB trigger hasn't fired yet (edge case on first login), insert on demand
export async function ensureProfile(id: string, email: string | null): Promise<Profile> {
  const existing = await findProfileById(id)
  if (existing) return existing
  const { data, error } = await supabase
    .from('profiles')
    .insert({ id, email })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToProfile(data as ProfileRow)
}

export async function updateProfile(id: string, input: UpdateProfileInput): Promise<Profile> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.fullName !== undefined) updates.full_name = input.fullName
  if (input.preferredLanguage !== undefined) updates.preferred_language = input.preferredLanguage

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToProfile(data as ProfileRow)
}
