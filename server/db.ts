// Tous les appels Supabase (base + stockage) passent par ce fichier.
import { createClient } from '@supabase/supabase-js'
import { env } from './env.js'

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
})

const BUCKET = 'sops'

export type SopStatus = 'uploading' | 'processing' | 'ready' | 'failed'
export type Voice = 'none' | 'standard' | 'premium'

export interface Sop {
  id: string
  userId: string
  title: string
  language: string
  voice: Voice
  status: SopStatus
  progress: string | null
  error: string | null
  creditsUsed: number
  sourcePath: string
  durationSeconds: number | null
  markdown: string | null
  videoPath: string | null
  createdAt: string
  updatedAt: string
}

interface SopRow {
  id: string
  user_id: string
  title: string
  language: string
  voice: Voice
  status: SopStatus
  progress: string | null
  error: string | null
  credits_used: number
  source_path: string
  duration_seconds: number | string | null
  markdown: string | null
  video_path: string | null
  created_at: string
  updated_at: string
}

function toSop(r: SopRow): Sop {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    language: r.language,
    voice: r.voice,
    status: r.status,
    progress: r.progress,
    error: r.error,
    creditsUsed: r.credits_used,
    sourcePath: r.source_path,
    durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
    markdown: r.markdown,
    videoPath: r.video_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Lève une erreur lisible si Supabase en renvoie une ; sinon renvoie les données. */
function check<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`)
  return result.data as T
}

// ── Auth ─────────────────────────────────────────────────────

export async function userIdFromToken(token: string): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser(token)
  return error || !data.user ? null : data.user.id
}

export async function userEmail(userId: string): Promise<string | null> {
  const { data } = await supabase.auth.admin.getUserById(userId)
  return data.user?.email ?? null
}

// ── Comptes & crédits ────────────────────────────────────────

export interface Account {
  credits: number
  stripeCustomerId: string | null
}

export async function getAccount(userId: string): Promise<Account> {
  const res = await supabase
    .from('accounts')
    .select('credits, stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle()
  const row = check<{ credits: number; stripe_customer_id: string | null } | null>(
    res,
    'getAccount',
  )
  return { credits: row?.credits ?? 0, stripeCustomerId: row?.stripe_customer_id ?? null }
}

export async function setStripeCustomerId(userId: string, customerId: string): Promise<void> {
  check(
    await supabase
      .from('accounts')
      .update({ stripe_customer_id: customerId })
      .eq('user_id', userId),
    'setStripeCustomerId',
  )
}

export async function findUserIdByStripeCustomer(customerId: string): Promise<string | null> {
  const res = await supabase
    .from('accounts')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()
  return check<{ user_id: string } | null>(res, 'findUserIdByStripeCustomer')?.user_id ?? null
}

/** Ajoute (delta > 0) ou débite (delta < 0). false = solde insuffisant ou `ref` déjà traité. */
export async function applyCredits(
  userId: string,
  delta: number,
  reason: string,
  ref?: string,
): Promise<boolean> {
  const res = await supabase.rpc('apply_credits', {
    p_user: userId,
    p_delta: delta,
    p_reason: reason,
    p_ref: ref ?? null,
  })
  return check(res, 'applyCredits') === true
}

// ── SOPs ─────────────────────────────────────────────────────

const SOP_COLUMNS =
  'id, user_id, title, language, voice, status, progress, error, credits_used, source_path, duration_seconds, markdown, video_path, created_at, updated_at'

export async function createSop(input: {
  id: string
  userId: string
  title: string
  language: string
  voice: Voice
  sourcePath: string
}): Promise<Sop> {
  const res = await supabase
    .from('sops')
    .insert({
      id: input.id,
      user_id: input.userId,
      title: input.title,
      language: input.language,
      voice: input.voice,
      source_path: input.sourcePath,
    })
    .select(SOP_COLUMNS)
    .single<SopRow>()
  return toSop(check(res, 'createSop'))
}

export async function listSops(userId: string): Promise<Sop[]> {
  const res = await supabase
    .from('sops')
    .select(SOP_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(200)
    .returns<SopRow[]>()
  return check(res, 'listSops').map(toSop)
}

export async function getSop(id: string): Promise<Sop | null> {
  const res = await supabase.from('sops').select(SOP_COLUMNS).eq('id', id).maybeSingle<SopRow>()
  const row = check<SopRow | null>(res, 'getSop')
  return row ? toSop(row) : null
}

export async function updateSop(
  id: string,
  patch: Partial<{
    status: SopStatus
    progress: string | null
    error: string | null
    creditsUsed: number
    durationSeconds: number
    markdown: string
    videoPath: string
  }>,
): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.status !== undefined) row.status = patch.status
  if (patch.progress !== undefined) row.progress = patch.progress
  if (patch.error !== undefined) row.error = patch.error
  if (patch.creditsUsed !== undefined) row.credits_used = patch.creditsUsed
  if (patch.durationSeconds !== undefined) row.duration_seconds = patch.durationSeconds
  if (patch.markdown !== undefined) row.markdown = patch.markdown
  if (patch.videoPath !== undefined) row.video_path = patch.videoPath
  check(await supabase.from('sops').update(row).eq('id', id), 'updateSop')
}

export async function deleteSop(id: string): Promise<void> {
  check(await supabase.from('sops').delete().eq('id', id), 'deleteSop')
}

// ── Stockage ─────────────────────────────────────────────────

export async function createUploadUrl(path: string): Promise<{ signedUrl: string; token: string }> {
  const res = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
  return check(res, 'createUploadUrl')
}

export async function fileExists(path: string): Promise<boolean> {
  const res = await fetch(publicUrl(path), { method: 'HEAD' })
  return res.ok
}

export async function uploadFile(path: string, body: Buffer, contentType: string): Promise<void> {
  const res = await supabase.storage.from(BUCKET).upload(path, body, { contentType, upsert: true })
  check(res, `uploadFile ${path}`)
}

export function publicUrl(path: string): string {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

export async function deleteFolder(prefix: string): Promise<void> {
  const res = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 })
  const files = check(res, 'deleteFolder list').map((f) => `${prefix}/${f.name}`)
  if (files.length > 0) check(await supabase.storage.from(BUCKET).remove(files), 'deleteFolder')
}
