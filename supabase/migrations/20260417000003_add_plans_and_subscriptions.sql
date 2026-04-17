-- Plans + subscriptions scaffolding.
-- Stripe columns (stripe_price_id, stripe_subscription_id, stripe_customer_id)
-- are nullable so the billing feature works without Stripe for now.
-- When Stripe is wired in, we only need to populate those columns + webhooks.

CREATE TABLE plans (
  id text PRIMARY KEY,                       -- 'free' | 'startup' | 'growth' | 'business'
  name text NOT NULL,
  price_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'EUR',
  stripe_price_id text,                      -- populated when Stripe is enabled
  max_projects integer NOT NULL,
  max_doc_runs integer NOT NULL,
  max_voiceovers integer NOT NULL,
  max_try_doc integer NOT NULL,
  max_widget_sessions integer NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  features jsonb NOT NULL DEFAULT '[]'::jsonb, -- human-readable bullets for the UI
  created_at timestamptz DEFAULT now()
);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Plans are readable by anyone" ON plans FOR SELECT USING (true);

INSERT INTO plans (id, name, price_cents, max_projects, max_doc_runs, max_voiceovers, max_try_doc, max_widget_sessions, sort_order, features) VALUES
  ('free',     'Free',     0,     1,  3,   3,   1,   50,    0,
   '["1 project","3 doc generations / month","3 voice-overs / month","1 Try Doc test / month","50 widget chat sessions / month","Community support"]'::jsonb),
  ('startup',  'Startup',  4900,  3,  50,  50,  20,  500,   1,
   '["3 projects","50 doc generations / month","50 voice-overs / month","20 Try Doc tests / month","500 widget chat sessions / month","Email support"]'::jsonb),
  ('growth',   'Growth',   14900, 10, 200, 200, 80,  3000,  2,
   '["10 projects","200 doc generations / month","200 voice-overs / month","80 Try Doc tests / month","3,000 widget chat sessions / month","Priority email support"]'::jsonb),
  ('business', 'Business', 44900, 40, 800, 800, 300, 15000, 3,
   '["40 projects","800 doc generations / month","800 voice-overs / month","300 Try Doc tests / month","15,000 widget chat sessions / month","Pay-as-you-go overages","Dedicated support"]'::jsonb);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id text NOT NULL DEFAULT 'free' REFERENCES plans(id),
  status text NOT NULL DEFAULT 'active',     -- active | canceled | past_due | trialing
  current_period_start timestamptz,
  current_period_end timestamptz,
  stripe_subscription_id text,               -- populated when Stripe is enabled
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- One active subscription per user
CREATE UNIQUE INDEX subscriptions_active_user_idx
  ON subscriptions (user_id)
  WHERE status <> 'canceled';

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own subscription" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- Extend the existing signup handler to also create a free subscription
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.subscriptions (user_id, plan_id, status)
  SELECT NEW.id, 'free', 'active'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.subscriptions s
    WHERE s.user_id = NEW.id AND s.status <> 'canceled'
  );

  RETURN NEW;
END;
$$;

-- Backfill a free subscription for any existing user who doesn't have one
INSERT INTO public.subscriptions (user_id, plan_id, status)
SELECT u.id, 'free', 'active' FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.subscriptions s
  WHERE s.user_id = u.id AND s.status <> 'canceled'
);
