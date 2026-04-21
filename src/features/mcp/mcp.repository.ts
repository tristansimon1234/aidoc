import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { McpUserToken, McpUserTokenSummary } from './mcp.types.js'

interface McpUserTokenRow {
  id: string
  user_id: string
  team_id: string
  name: string
  token: string
  last_used_at: string | null
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
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
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
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    createdAt: new Date(row.created_at),
  }
}

export async function createToken(input: {
  userId: string
  teamId: string
  name: string
  token: string
}): Promise<McpUserToken> {
  const { data, error } = await supabase
    .from('mcp_user_tokens')
    .insert({
      user_id: input.userId,
      team_id: input.teamId,
      name: input.name,
      token: input.token,
    })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToken(data as McpUserTokenRow)
}

/** Resolve a raw token string to its row. Returns null when the token is
 *  unknown or revoked — the caller never learns which. */
export async function findActiveTokenByValue(tokenValue: string): Promise<McpUserToken | null> {
  const { data, error } = await supabase
    .from('mcp_user_tokens')
    .select('*')
    .eq('token', tokenValue)
    .is('revoked_at', null)
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

/** Fire-and-forget: bump last_used_at on a successful MCP request. Never
 *  throws — a write failure here should not abort the tool call. */
export async function touchTokenLastUsed(tokenId: string): Promise<void> {
  try {
    await supabase
      .from('mcp_user_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', tokenId)
  } catch {
    // Best-effort.
  }
}
