-- PR 1: Profiles (1:1 with auth.users) + per-project language
-- Prepares the app for multi-tenant SaaS: user-level preferences (language)
-- and per-project language for generated docs / chat / widget.

-- Profiles: one row per authenticated user
CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  full_name text,
  preferred_language text NOT NULL DEFAULT 'en',
  stripe_customer_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_profiles_stripe_customer_id ON profiles(stripe_customer_id);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Each user can read/update only their own row
CREATE POLICY "Users read own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);

-- Auto-create a profile row whenever a new auth user is created
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
    COALESCE(NEW.raw_user_meta_data->>'full_name', NULL)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill profiles for any existing auth users
INSERT INTO public.profiles (id, email)
SELECT id, email FROM auth.users
ON CONFLICT (id) DO NOTHING;

-- Per-project language (used by doc generation, chat, voice-over, widget)
ALTER TABLE projects ADD COLUMN language text NOT NULL DEFAULT 'en';

COMMENT ON COLUMN projects.language IS 'ISO code for generated docs, chat, voice-over, and widget UI (e.g. en, fr)';
COMMENT ON COLUMN profiles.preferred_language IS 'User UI language preference. Projects inherit this on creation but can override.';
