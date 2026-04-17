-- Switch plans to a single "monthly_tokens" budget instead of 4 per-feature quotas.
-- Each metered operation consumes a configurable number of tokens (defined
-- app-side in billing.service.ts so we can tune rates without a migration).
-- The UI shows only a single usage percentage — numbers stay backend-only.

ALTER TABLE plans ADD COLUMN monthly_tokens integer NOT NULL DEFAULT 0;

-- Seed values are derived from the previous quotas × token cost per op:
--   doc_run = 100, voiceover = 300, try_doc = 400, chat_session = 20
-- Rounded up to tidy round numbers (the user sees % only, exact budget doesn't matter).
UPDATE plans SET monthly_tokens = CASE id
  WHEN 'free'     THEN 3000
  WHEN 'startup'  THEN 40000
  WHEN 'growth'   THEN 180000
  WHEN 'business' THEN 800000
  ELSE monthly_tokens
END;

-- Drop the old per-feature quota columns — now all usage is measured in tokens.
ALTER TABLE plans DROP COLUMN max_doc_runs;
ALTER TABLE plans DROP COLUMN max_voiceovers;
ALTER TABLE plans DROP COLUMN max_try_doc;
ALTER TABLE plans DROP COLUMN max_chat_sessions;

-- Make the plan feature bullets opaque: no raw numbers, so we can change the
-- token cost of any operation on our side without breaking expectations.
UPDATE plans SET features = CASE id
  WHEN 'free' THEN
    '["1 project","Monthly usage for evaluating the product","Community support"]'::jsonb
  WHEN 'startup' THEN
    '["3 projects","Monthly usage for small teams","Email support"]'::jsonb
  WHEN 'growth' THEN
    '["10 projects","Monthly usage for growing teams","Priority email support"]'::jsonb
  WHEN 'business' THEN
    '["40 projects","Monthly usage for larger teams","Pay-as-you-go overages","Dedicated support"]'::jsonb
  ELSE features
END;
