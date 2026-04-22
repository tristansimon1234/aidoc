import { createHash } from 'node:crypto'
import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { McpScope, McpUserToken, McpUserTokenSummary } from './mcp.types.js'

interface McpUserTokenRow {
  id: string
  user_id: string
  team_id: string
  name: string
  token: string | null
  token_hash: string | null
  preview: string | null
  scope: McpScope
  last_used_at: string | null
  last_used_ip: string | null
  expires_at: string | null
  revoked_at: string | null
  created_at: string
}

/** SHA-256 of a raw MCP token. Fixed algorithm (not bcrypt): we need an
 *  indexed lookup on the hash, and the token itself has 256 bits of entropy
 *  so rainbow-table attacks are impractical. The hash exists to defuse DB
 *  backup leaks, not to slow down online guessing. */
export function hashMcpToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

function previewOf(raw: string): string {
  return raw.slice(-4)
}

function mapToken(row: McpUserTokenRow): McpUserToken {
  // `token` is only populated post-create (by createToken). Lookups return
  // null — the raw token isn't recoverable from the stored hash. Callers that
  // need a preview should read `preview` directly.
  return {
    id: row.id,
    userId: row.user_id,
    teamId: row.team_id,
    name: row.name,
    token: row.token ?? '',
    scope: row.scope,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    lastUsedIp: row.last_used_ip,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    createdAt: new Date(row.created_at),
  }
}

function mapTokenSummary(row: McpUserTokenRow): McpUserTokenSummary {
  // Prefer the explicit preview column; fall back to a legacy derivation
  // from the raw `token` column for rows migrated before preview was wired.
  const preview = row.preview ?? row.token?.slice(-4) ?? '••••'
  return {
    id: row.id,
    userId: row.user_id,
    teamId: row.team_id,
    name: row.name,
    preview,
    scope: row.scope,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    lastUsedIp: row.last_used_ip,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    createdAt: new Date(row.created_at),
  }
}

export async function createToken(input: {
  userId: string
  teamId: string
  name: string
  token: string
  scope: McpScope
  expiresAt: Date | null
}): Promise<McpUserToken> {
  // Store the hash — the raw token is never kept at rest. We keep a 4-char
  // preview separately so the UI can still render "…a3f7" for the row.
  const hash = hashMcpToken(input.token)
  const preview = previewOf(input.token)
  const { data, error } = await supabase
    .from('mcp_user_tokens')
    .insert({
      user_id: input.userId,
      team_id: input.teamId,
      name: input.name,
      // token column is DEPRECATED but still NOT NULL UNIQUE on older DBs —
      // write the hash there too as a bridge until the migration can drop it.
      // UNIQUE holds because hash is globally unique.
      token: hash,
      token_hash: hash,
      preview,
      scope: input.scope,
      expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
    })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  const mapped = mapToken(data as McpUserTokenRow)
  // Return the RAW token this one time — the caller (route) echoes it back
  // to the user who just generated it. It is NOT recoverable afterwards.
  return { ...mapped, token: input.token }
}

/** Resolve a raw token string to its row. Returns null when the token is
 *  unknown, revoked, or past its expiry — the caller never learns which.
 *  Distinct expired-vs-revoked surfacing happens in the route layer when
 *  needed (we look up the row again to disambiguate the error message). */
export async function findActiveTokenByValue(tokenValue: string): Promise<McpUserToken | null> {
  const hash = hashMcpToken(tokenValue)
  const { data, error } = await supabase
    .from('mcp_user_tokens')
    .select('*')
    .eq('token_hash', hash)
    .is('revoked_at', null)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  if (!data) return null
  const token = mapToken(data as McpUserTokenRow)
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return null
  return token
}

/** Look up a token row by value WITHOUT filtering on revoked_at / expires_at,
 *  so the route layer can return a precise error (`TOKEN_EXPIRED` vs
 *  `TOKEN_REVOKED` vs `TOKEN_UNKNOWN`). Single extra round-trip on the
 *  unhappy path only — successful requests never hit this. */
export async function findTokenByValueAnyState(tokenValue: string): Promise<McpUserToken | null> {
  const hash = hashMcpToken(tokenValue)
  const { data, error } = await supabase
    .from('mcp_user_tokens')
    .select('*')
    .eq('token_hash', hash)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return data ? mapToken(data as McpUserTokenRow) : null
}

export async function listTokensForUser(userId: string): Promise<McpUserTokenSummary[]> {
  const { data, error } = await supabase
    .from('mcp_user_tokens')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw new DatabaseError(error.message)
  return (data as McpUserTokenRow[]).map(mapTokenSummary)
}

/** Soft delete — sets revoked_at so the row is kept for audit but no longer
 *  resolves. Authed route asserts ownership before calling this. */
export async function revokeToken(tokenId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('mcp_user_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', tokenId)
    .eq('user_id', userId)
  if (error) throw new DatabaseError(error.message)
}

/** Schedule a token for revocation at a specific timestamp. Implemented as a
 *  short expires_at — keeps the old token alive long enough to avoid breaking
 *  a session in flight after a user rotates. */
export async function scheduleRevocation(
  tokenId: string,
  userId: string,
  revokeAt: Date,
): Promise<void> {
  const { error } = await supabase
    .from('mcp_user_tokens')
    .update({ expires_at: revokeAt.toISOString() })
    .eq('id', tokenId)
    .eq('user_id', userId)
  if (error) throw new DatabaseError(error.message)
}

/** Find the row by id + owner. Used by the rotate endpoint to copy
 *  scope / expiry from the token being rotated. */
export async function findTokenByIdForUser(
  tokenId: string,
  userId: string,
): Promise<McpUserToken | null> {
  const { data, error } = await supabase
    .from('mcp_user_tokens')
    .select('*')
    .eq('id', tokenId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return data ? mapToken(data as McpUserTokenRow) : null
}

/** Fire-and-forget: bump last_used_at + last_used_ip on a successful MCP
 *  request. Never throws — a write failure here should not abort the tool
 *  call. The IP is captured at the route boundary; null is fine when we
 *  can't determine it (no trust-proxy, malformed forwarded header, etc.). */
export async function touchTokenLastUsed(tokenId: string, ip: string | null): Promise<void> {
  try {
    const update: { last_used_at: string; last_used_ip?: string } = {
      last_used_at: new Date().toISOString(),
    }
    if (ip) update.last_used_ip = ip
    await supabase.from('mcp_user_tokens').update(update).eq('id', tokenId)
  } catch {
    // Best-effort.
  }
}
