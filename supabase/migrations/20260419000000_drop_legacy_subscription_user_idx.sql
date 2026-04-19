-- Drop the legacy `subscriptions_active_user_idx` (unique per user) if it's
-- still present. The teams migration 20260418000005 was meant to drop it and
-- replace it with `idx_subscriptions_team_active` (unique per team), but on
-- some environments the DROP didn't take — the old index lingers and causes
-- duplicate-key errors when the billing flow tries to insert a new
-- subscription for a user who already had one pre-teams.
--
-- Idempotent: safe on envs where the index was already removed.

DROP INDEX IF EXISTS public.subscriptions_active_user_idx;
