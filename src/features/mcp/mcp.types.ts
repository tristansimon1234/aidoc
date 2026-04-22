export type McpScope = 'read' | 'write' | 'admin'

export interface McpUserToken {
  id: string
  userId: string
  teamId: string
  name: string
  /** Full token string. Only populated on create; list endpoints mask it. */
  token: string
  scope: McpScope
  lastUsedAt: Date | null
  lastUsedIp: string | null
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

/** Resolved authentication context for an MCP request — every tool call
 *  operates strictly within this user + team pair. */
export interface McpAuthContext {
  userId: string
  teamId: string
  tokenId: string
  scope: McpScope
}

/** Safe-to-expose summary of a token (no full secret). Used by the list
 *  endpoint and the UI. `preview` is the last 4 characters so users can
 *  recognize a token they already pasted into a client. */
export interface McpUserTokenSummary {
  id: string
  userId: string
  teamId: string
  name: string
  preview: string
  scope: McpScope
  lastUsedAt: Date | null
  lastUsedIp: string | null
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}
