-- Initial schema for the standalone SaaS Video product.
--
-- Three tables, all RLS-isolated per auth.users.id:
--   brands           — per-user brand identities (logo, colors, font, website)
--   marketing_videos — first-class persistence, replaces Doclee's runs.summary_json.marketingVideo
--   user_credits     — credit-pack balance, decremented on successful render

-- ============================================================
-- brands
-- ============================================================
CREATE TABLE brands (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  logo_url     text,
  logo_path    text,
  -- Stored as hex strings (#RRGGBB) — same shape Doclee uses, validated by Zod
  -- at the API boundary so the renderer doesn't need to handle alternate formats.
  accent_color text NOT NULL DEFAULT '#5B5BD6',
  bg_color     text NOT NULL DEFAULT '#0B0B0F',
  text_color   text NOT NULL DEFAULT '#F5F5F7',
  font_family  text NOT NULL DEFAULT 'Inter',
  website_url  text,
  -- A user can have multiple brands (one per product / client / variant) but
  -- exactly one is the default surfaced first in pickers + used when no
  -- brand_id is passed explicitly during video creation.
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_brands_user ON brands(user_id);
-- Partial unique index: at most one default brand per user. Lets us flip
-- the flag without a transaction (clear-then-set is racy under concurrency).
CREATE UNIQUE INDEX idx_brands_user_one_default
  ON brands(user_id)
  WHERE is_default = true;

ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users access own brands" ON brands
  FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- marketing_videos
-- ============================================================
-- Lifecycle states:
--   pending     — row created, pipeline not started yet
--   generating  — script + voice + music in flight (the slow part)
--   rendering   — manifest persisted, Remotion render in flight
--   ready       — MP4 uploaded, video_url populated
--   failed      — terminal; render_error carries the human-readable reason
CREATE TABLE marketing_videos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brand_id      uuid NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
  title         text NOT NULL,
  brief         text NOT NULL,
  -- MarketingManifest (script + screenshots + branding snapshot + voice/music URLs).
  -- Nullable until the generate pipeline writes it on first success.
  manifest      jsonb,
  video_url     text,
  video_path    text,
  -- Stored alongside the manifest for the gallery thumbnail. Captured client-side
  -- ~4s into the rendered video, then uploaded via POST /:id/thumbnail.
  thumbnail_url text,
  thumbnail_path text,
  render_status text NOT NULL DEFAULT 'pending'
    CHECK (render_status IN ('pending', 'generating', 'rendering', 'ready', 'failed')),
  render_error  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_marketing_videos_user_created ON marketing_videos(user_id, created_at DESC);
CREATE INDEX idx_marketing_videos_brand ON marketing_videos(brand_id);
-- Concurrency: at most one in-flight generate/render per user at any time.
-- Avoids a user double-clicking Generate and burning two credits at once.
-- WHERE clause keeps the index small (only the few rows actively in flight).
CREATE UNIQUE INDEX idx_marketing_videos_one_in_flight_per_user
  ON marketing_videos(user_id)
  WHERE render_status IN ('generating', 'rendering');

ALTER TABLE marketing_videos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users access own videos" ON marketing_videos
  FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- user_credits
-- ============================================================
-- One row per user, created on signup (via the on-auth-user-created trigger
-- below). Balance starts at 1 so the user can try the product once for free.
-- Stripe webhook bumps balance + total_bought when a credit-pack purchase
-- completes; the marketing-video service decrements balance by 1 at the
-- start of each generate call (inside a transaction so a failed pipeline
-- can refund).
CREATE TABLE user_credits (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance        integer NOT NULL DEFAULT 1 CHECK (balance >= 0),
  total_bought   integer NOT NULL DEFAULT 0 CHECK (total_bought >= 0),
  -- Optional Stripe customer id, set when the user does their first checkout.
  -- Persisted so subsequent purchases hit the same customer (consolidated
  -- billing history in the Stripe dashboard + saved payment methods).
  stripe_customer_id text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_credits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own credits" ON user_credits
  FOR SELECT USING (user_id = auth.uid());
-- INSERT/UPDATE only happen server-side (service-role key), so no policies
-- for those — the missing policy denies them under RLS.

-- ============================================================
-- Helper: bootstrap user_credits row on signup
-- ============================================================
-- Without this we'd have to special-case "first call from this user" in
-- the credits service. A SECURITY DEFINER trigger seeds the row at the
-- moment auth.users is written, so the balance is always queryable.
CREATE OR REPLACE FUNCTION public.bootstrap_user_credits()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  INSERT INTO user_credits (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created_bootstrap_credits
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.bootstrap_user_credits();

-- ============================================================
-- updated_at triggers (idempotent — function shared across tables)
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER brands_set_updated_at
  BEFORE UPDATE ON brands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER marketing_videos_set_updated_at
  BEFORE UPDATE ON marketing_videos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER user_credits_set_updated_at
  BEFORE UPDATE ON user_credits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
