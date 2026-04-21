-- Per-user MCP personal access tokens, scoped to a single workspace.
--
-- Each row authenticates an MCP client as a specific (user, team) pair.
-- All MCP tool calls operate only on projects within that team. A user can
-- hold multiple tokens (one per workspace they're a member of). Revocation
-- is a soft delete (revoked_at) so we can still show it in history if needed.

CREATE TABLE mcp_user_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name text NOT NULL,
  token text NOT NULL UNIQUE,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mcp_user_tokens_user_id ON mcp_user_tokens(user_id);
CREATE INDEX idx_mcp_user_tokens_token_active ON mcp_user_tokens(token) WHERE revoked_at IS NULL;

ALTER TABLE mcp_user_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own mcp tokens" ON mcp_user_tokens
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users insert own mcp tokens" ON mcp_user_tokens
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own mcp tokens" ON mcp_user_tokens
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users delete own mcp tokens" ON mcp_user_tokens
  FOR DELETE USING (auth.uid() = user_id);
