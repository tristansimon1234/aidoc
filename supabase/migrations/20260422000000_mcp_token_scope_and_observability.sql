-- Adds scope, optional expiry, and last-used IP to MCP user tokens.
--
-- Scopes give tokens fine-grained capability — a `read` token can list and
-- search but never mutate, useful for monitoring or RAG integrations. Expiry
-- is opt-in (default null = never) because forced expiry on bare API keys
-- breaks long-running integrations more than it protects them. last_used_ip
-- gives the user enough signal to spot a compromised token without us
-- imposing a forced rotation policy.

ALTER TABLE mcp_user_tokens
  ADD COLUMN scope text NOT NULL DEFAULT 'admin'
    CHECK (scope IN ('read', 'write', 'admin')),
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN last_used_ip text;

-- Pre-existing tokens stay 'admin' so nothing breaks. New tokens default to
-- 'admin' too at the route level (see tokens.routes.ts) for backwards-compat
-- with clients that don't pass a scope yet.
