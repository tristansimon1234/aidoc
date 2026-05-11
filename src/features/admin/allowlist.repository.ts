import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { AllowedEmail } from './allowlist.types.js'

interface Row {
  email: string
  note: string | null
  created_at: string
  created_by: string | null
}

function toDomain(row: Row): AllowedEmail {
  return {
    email: row.email,
    note: row.note,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }
}

export async function listAllowedEmails(): Promise<AllowedEmail[]> {
  const { data, error } = await supabase
    .from('allowed_emails')
    .select('email, note, created_at, created_by')
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw new DatabaseError(error.message)
  return (data as Row[]).map(toDomain)
}

export async function addAllowedEmail(
  email: string,
  note: string | null,
  createdBy: string,
): Promise<AllowedEmail> {
  const { data, error } = await supabase
    .from('allowed_emails')
    .upsert(
      { email, note, created_by: createdBy },
      { onConflict: 'email', ignoreDuplicates: false },
    )
    .select('email, note, created_at, created_by')
    .single()
  if (error) throw new DatabaseError(error.message)
  return toDomain(data as Row)
}

export async function removeAllowedEmail(email: string): Promise<void> {
  const { error } = await supabase.from('allowed_emails').delete().eq('email', email)
  if (error) throw new DatabaseError(error.message)
}
