import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import { isAdminEmail } from '../../shared/config/env.js'
import type { Profile, UpdateProfileInput } from './profile.types.js'

/**
 * Look up a user's email from the auth.users table (accessed via the admin API).
 * Used to seed the profile row on the first API call if the trigger didn't fire.
 */
export async function findAuthUserEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId)
  if (error || !data.user) return null
  return data.user.email ?? null
}

/**
 * Resolve display names (full_name, falling back to email) for a set of
 * user ids in one batch. Used by activity feeds / audit trails to avoid
 * N+1 profile lookups. Returns an empty map on error — the caller should
 * render "anonymous" gracefully rather than fail the whole feed.
 */
export async function findProfileNamesByIds(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name')
    .in('id', userIds)
  if (error) return new Map()
  const map = new Map<string, string>()
  for (const row of data ?? []) {
    const r = row as { id: string; email: string | null; full_name: string | null }
    const name = r.full_name ?? r.email ?? null
    if (name) map.set(r.id, name)
  }
  return map
}

interface ProfileRow {
  id: string
  email: string | null
  full_name: string | null
  stripe_customer_id: string | null
  created_at: string
  updated_at: string
}

function mapToProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    stripeCustomerId: row.stripe_customer_id,
    isAdmin: isAdminEmail(row.email),
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

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToProfile(data as ProfileRow)
}
