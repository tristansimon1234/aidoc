-- Recalibrate the per-plan token budgets from the rebrand migration.
-- Original budgets (40k / 200k / 1M) were set proportionally to the old
-- plan tiers but the new prices are aggressive early-stage numbers, so
-- at 100 % quota consumption every paid plan was operating at a loss
-- (~0.001 € COGS per token vs prices of 19 / 59 / 149 €). Agency was
-- net-negative even at typical 20 % utilization.
--
-- New budgets keep a comfortable margin at realistic usage while the
-- overage rails (Team / Agency) absorb power users without inflating the
-- included quota. Free stays untouched.

UPDATE plans SET monthly_tokens = 30000   WHERE id = 'founder';
UPDATE plans SET monthly_tokens = 100000  WHERE id = 'team';
UPDATE plans SET monthly_tokens = 500000  WHERE id = 'agency';
