-- Add 'marketing_video' to the usage_counters.feature CHECK constraint so the
-- marketing-video pipeline can bump its monthly counter via increment_usage.
-- The feature is the heaviest single op (Gemini Pro script + ElevenLabs voice
-- + ElevenLabs music + Railway render — ~€0.60 COGS) and was previously
-- unmetered. Token weight = 600, see TOKEN_COSTS in
-- src/features/billing/billing.service.ts.

ALTER TABLE usage_counters
  DROP CONSTRAINT IF EXISTS usage_counters_feature_check;

ALTER TABLE usage_counters
  ADD CONSTRAINT usage_counters_feature_check
  CHECK (feature IN ('doc_run', 'voiceover', 'try_doc', 'chat_sessions', 'marketing_video'));
