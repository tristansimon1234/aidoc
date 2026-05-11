-- Email allowlist for design-partner phase.
--
-- Doclee is closed: public signup must be rejected unless the email is on
-- `allowed_emails`. This is enforced by a BEFORE INSERT trigger on
-- `auth.users` so it catches every signup path (password, magic link, OAuth,
-- admin-invite from the Supabase dashboard) — the app layer can't bypass it
-- and neither can a future client that we forget to update.
--
-- Existing users keep working; the trigger only checks new inserts. The
-- bootstrap INSERT at the bottom seeds the current `auth.users` set so the
-- table starts coherent with reality.
--
-- Admin CRUD lives at /api/admin/allowlist (gated by requireAdmin +
-- ADMIN_EMAILS).

CREATE TABLE allowed_emails (
  email text PRIMARY KEY,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE allowed_emails IS
  'Email allowlist. A signup is rejected unless lower(new.email) appears here.';

-- Lowercase comparison: we normalise the email at insert time and on lookup.
-- Email addresses are case-insensitive in the local-part per practical use
-- (RFC says otherwise, but no provider respects that and Supabase normalises).
ALTER TABLE allowed_emails
  ADD CONSTRAINT allowed_emails_lowercase CHECK (email = lower(email));

ALTER TABLE allowed_emails ENABLE ROW LEVEL SECURITY;
-- No policies → no direct client access. All reads/writes go through the
-- service-role key in admin.allowlist.repository.ts.

CREATE OR REPLACE FUNCTION public.enforce_email_allowlist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NULL THEN
    -- Anonymous / phone-only signups would slip through an email check. We
    -- don't use them today, but refuse to fail open.
    RAISE EXCEPTION 'Signup blocked: email required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.allowed_emails WHERE email = lower(NEW.email)
  ) THEN
    RAISE EXCEPTION 'Signup blocked: % is not on the allowlist', NEW.email
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_email_allowlist_trigger ON auth.users;
CREATE TRIGGER enforce_email_allowlist_trigger
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_email_allowlist();

-- Bootstrap: seed every existing auth user so we don't lock anyone out.
-- Without this, the next time an existing user signs in (or a session is
-- refreshed in a way that re-touches auth.users), the trigger could refuse.
-- In practice BEFORE INSERT only fires on actual inserts, but seeding is
-- still the safe default — admins want the table to match reality on day 1.
INSERT INTO public.allowed_emails (email, note)
SELECT lower(email), 'bootstrap: existing user at migration time'
FROM auth.users
WHERE email IS NOT NULL
ON CONFLICT (email) DO NOTHING;
