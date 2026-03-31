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

export function getPublicUrl(bucket: string, path: string): string | null {
  if (!path) return null
  try {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path)
    return data.publicUrl && data.publicUrl.startsWith('http') ? data.publicUrl : null
  } catch {
    return null
  }
}
