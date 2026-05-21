import { supabase } from '../db/supabase.client.js'
import { DatabaseError } from '../middleware/error.middleware.js'

export async function uploadToStorage(
  bucket: string,
  path: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  const { error } = await supabase.storage.from(bucket).upload(path, data, {
    contentType,
    upsert: true,
  })
  if (error) throw new DatabaseError(`Storage upload failed: ${error.message}`)
  return path
}

export async function createSignedUploadUrl(
  bucket: string,
  path: string,
): Promise<string> {
  // upsert:true lets Replace flows PUT to the same path as the existing
  // file. Without it Supabase returns "The resource already exists" and
  // the user can't overwrite their own video / audio.
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUploadUrl(path, { upsert: true })
  if (error || !data) throw new DatabaseError(`Signed URL failed: ${error?.message ?? 'no data'}`)
  return data.signedUrl
}

export function getPublicUrl(bucket: string, path: string): string | null {
  if (!path) return null
  try {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path)
    return data.publicUrl && data.publicUrl.startsWith('http') ? data.publicUrl : null
  } catch {
    return null
  }
}

/**
 * Get a signed URL for a storage object (works for private buckets).
 * Default expiry: 1 year (31536000 seconds).
 */
export async function getSignedUrl(
  bucket: string,
  path: string,
  expiresIn = 31536000,
): Promise<string | null> {
  if (!path) return null
  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn)
    if (error || !data?.signedUrl) return null
    return data.signedUrl
  } catch {
    return null
  }
}

/**
 * Download a storage object as a Buffer. Returns null if not found / unreadable
 * (non-throwing because callers typically fall back on missing files).
 */
export async function downloadFromStorage(bucket: string, path: string): Promise<Buffer | null> {
  if (!path) return null
  const { data, error } = await supabase.storage.from(bucket).download(path)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}
