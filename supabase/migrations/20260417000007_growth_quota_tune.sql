-- Tune Growth plan margins + expose pay-as-you-go overage on Growth + Business.
--
-- Growth at 149 € with the original quotas (200/200/80/3000) had worst-case
-- COGS ≈ 172 €, i.e. a net loss if a user consumed their full budget. Two
-- fixes applied together:
--
-- 1. Reduce Growth quotas ~25-30 % → worst-case COGS drops to ≈ 124 €
--    (gross margin worst-case +25 € instead of -23 €).
-- 2. Enable overage billing on Growth (previously only Business) so users
--    who genuinely need more don't hit a wall — they just pay per-unit
--    beyond the quota. Free + Startup stay hard-capped (push to upgrade).
--
-- Overage rates live in code (`OVERAGE_EUR` in billing.service.ts) so we
-- can tune them without a migration.

UPDATE plans SET monthly_tokens = 124000 WHERE id = 'growth';

UPDATE plans SET features = CASE id
  WHEN 'growth' THEN
    '["10 projects","~150 doc generations / month","~150 voice-overs / month","~60 Try Doc tests / month","~2,000 chat sessions / month","Pay-as-you-go beyond quota","Priority email support"]'::jsonb
  ELSE features
END;
