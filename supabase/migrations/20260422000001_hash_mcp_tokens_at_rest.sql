-- Hash MCP user tokens at rest.
--
-- Before: `mcp_user_tokens.token` held the raw Bearer token string. A database
-- dump / backup leak would hand an attacker working credentials.
--
-- After: we store SHA-256 hashes of the token in `token_hash`, and expose the
-- last 4 raw characters in `preview` so the UI can still render "…a3f7" for
-- the token list. Lookups hash the incoming value and compare. Existing rows
-- hold hashes backfilled at app layer from the raw `token` column the first
-- time they're seen, then NULLed; no existing raw tokens should have been
-- issued yet (pre-launch), but the code is defensive.
--
-- Why SHA-256 over bcrypt: MCP token lookup must be O(1) on the DB (no row
-- scan), so we can't use a per-row salt. Tokens are 32 random bytes
-- (base64url) = 256 bits of entropy; rainbow-table attacks are impractical.
-- The hash exists to neutralise database-dump leaks, not guess-at-rest.

ALTER TABLE mcp_user_tokens
  ADD COLUMN IF NOT EXISTS token_hash text,
  ADD COLUMN IF NOT EXISTS preview text;

-- Keep a unique index on the hash so lookup is still a single indexed read.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_user_tokens_hash ON mcp_user_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_user_tokens_hash_active ON mcp_user_tokens(token_hash) WHERE revoked_at IS NULL;

-- The legacy `token` column stays NOT NULL UNIQUE for now to keep backfill
-- simple. Once all rows have been rotated (app-level check confirms
-- token_hash populated) we can drop it in a follow-up migration.
COMMENT ON COLUMN mcp_user_tokens.token IS 'DEPRECATED — raw token, nulled after backfill. Use token_hash for lookups.';
COMMENT ON COLUMN mcp_user_tokens.token_hash IS 'SHA-256 hex of the raw token.';
COMMENT ON COLUMN mcp_user_tokens.preview IS 'Last 4 chars of the raw token, for UI display only.';
