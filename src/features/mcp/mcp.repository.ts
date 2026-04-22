import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { McpScope, McpUserToken, McpUserTokenSummary } from './mcp.types.js'

interface McpUserTokenRow {
  id: string
  user_id: string
  team_id: string
  name: string
  token: string
  scope: McpScope
  last_used_at: string | null
  last_used_ip: string | null
  expires_at: string | null
  revoked_at: string | null
  created_at: string
}

function mapToken(row: McpUserTokenRow): McpUserToken {
  return {
    id: row.id,
    userId: row.user_id,
    teamId: row.team_id,
    name: row.name,
    token: row.token,
    scope: row.scope,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    lastUsedIp: row.last_used_ip,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    createdAt: new Date(row.created_at),
  }
}

function mapTokenSummary(row: McpUserTokenRow): McpUserTokenSummary {
  return {
    id: row.id,
    userId: row.user_id,
    teamId: row.team_id,
    name: row.name,
    preview: row.token.slice(-4),
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
  const { data, error } = await supabase
    .from('mcp_user_tokens')
    .insert({
      user_id: input.userId,
      team_id: input.teamId,
      name: input.name,
      token: input.token,
      scope: input.scope,
      expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
    })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToken(data as McpUserTokenRow)
}

/** Resolve a raw token string to its row. Returns null when the token is
 *  unknown, revoked, or past its expiry — the caller never learns which.
 *  Distinct expired-vs-revoked surfacing happens in the route layer when
 *  needed (we look up the row again to disambiguate the error message). */
export async function findActiveTokenByValue(tokenValue: string): Promise<McpUserToken | null> {
  const { data, error } = await supabase
    .from('mcp_user_tokens')
    .select('*')
    .eq('token', tokenValue)
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
  const { data, error } = await supabase
    .from('mcp_user_tokens')
    .select('*')
    .eq('token', tokenValue)
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
