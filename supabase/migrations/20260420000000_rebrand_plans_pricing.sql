-- Rebrand pricing tiers around real personas instead of generic
-- startup/growth/business labels:
--
--   free      → Free      (unchanged)
--   startup   → Founder   (solo founder / freelance: 5 projects, 19 €)
--   growth    → Team      (Head of Product / Support: 15 projects, 59 €)
--   business  → Agency    (AI/Ops consultants, agencies: 50 projects, 149 €)
--
-- Prices dropped across the board for early-stage adoption — we'd rather
-- have design partners than MRR per account right now. Project caps went
-- up because the current 3/10/40 shape didn't fit a freelancer's side
-- projects or an agency's client roster.
--
-- plan_id is the FK on subscriptions (no ON UPDATE CASCADE) so we can't
-- rename in place — we insert the new rows, migrate subscriptions across,
-- then delete the retired rows.

INSERT INTO plans (id, name, price_cents, currency, max_projects, monthly_tokens, sort_order, features) VALUES
  ('founder', 'Founder', 1900, 'EUR', 5, 40000, 1,
   '["5 projects","Monthly usage for a solo founder","Widget + MCP without watermark","Email support"]'::jsonb),
  ('team',    'Team',    5900, 'EUR', 15, 200000, 2,
   '["15 projects","Monthly usage for a product / support team","Team members + analytics","Pay-as-you-go beyond quota","Priority email support"]'::jsonb),
  ('agency',  'Agency',  14900, 'EUR', 50, 1000000, 3,
   '["50 projects","Monthly usage for agencies and consultants","One project per client, MCP per project","Pay-as-you-go beyond quota","Dedicated support"]'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price_cents = EXCLUDED.price_cents,
  max_projects = EXCLUDED.max_projects,
  monthly_tokens = EXCLUDED.monthly_tokens,
  sort_order = EXCLUDED.sort_order,
  features = EXCLUDED.features;

-- Refresh Free copy to sit cleanly alongside the new tiers.
UPDATE plans SET
  sort_order = 0,
  features = '["1 project","Monthly usage for evaluating the product","Widget with Doclee watermark","Community support"]'::jsonb
WHERE id = 'free';

-- Migrate live subscriptions across. Any user still on the old tiers ends
-- up on the closest new equivalent (same slot in the ladder).
UPDATE subscriptions SET plan_id = 'founder' WHERE plan_id = 'startup';
UPDATE subscriptions SET plan_id = 'team'    WHERE plan_id = 'growth';
UPDATE subscriptions SET plan_id = 'agency'  WHERE plan_id = 'business';

-- Retire the old rows now that nothing references them.
DELETE FROM plans WHERE id IN ('startup', 'growth', 'business');
