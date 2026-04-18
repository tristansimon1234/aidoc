-- Teams: multi-tenant layer above projects.
-- Every user gets a "personal" team on signup; existing users are backfilled.
-- Projects, subscriptions and usage_counters gain a team_id; RLS stays on
-- user_id for now and will be flipped in the next migration after the
-- backend code is deployed.

-- ============================================================
-- 1. Tables
-- ============================================================

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  personal boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_teams_created_by ON teams (created_by);

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX idx_team_members_user ON team_members (user_id);

CREATE TABLE team_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email text NOT NULL,
  token text UNIQUE NOT NULL,
  invited_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  expires_at timestamptz NOT NULL DEFAULT (now() + INTERVAL '14 days'),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, email)
);
CREATE INDEX idx_team_invites_pending_token ON team_invites (token) WHERE accepted_at IS NULL;

COMMENT ON TABLE teams IS 'Multi-tenant workspace. Every user has at least one (their personal workspace).';
COMMENT ON COLUMN teams.personal IS 'true for the auto-created workspace on signup. Cannot be deleted.';
COMMENT ON TABLE team_members IS 'Role-based membership. Owners can invite/remove and manage the subscription.';
COMMENT ON TABLE team_invites IS 'Pending + accepted invites. Token is a random 32-byte base64url nonce sent in the invite email.';

-- ============================================================
-- 2. Add team_id to existing owned resources
-- ============================================================

ALTER TABLE projects ADD COLUMN team_id uuid REFERENCES teams(id) ON DELETE CASCADE;
CREATE INDEX idx_projects_team ON projects (team_id);

ALTER TABLE subscriptions ADD COLUMN team_id uuid REFERENCES teams(id) ON DELETE CASCADE;
-- Drop the old "one active subscription per user" index — multi-team means
-- one user can own multiple active subscriptions (one per team they created).
DROP INDEX IF EXISTS subscriptions_active_user_idx;
-- Partial unique: one active subscription per team
CREATE UNIQUE INDEX idx_subscriptions_team_active ON subscriptions (team_id) WHERE status = 'active';

ALTER TABLE usage_counters ADD COLUMN team_id uuid REFERENCES teams(id) ON DELETE CASCADE;
CREATE INDEX idx_usage_counters_team_period ON usage_counters (team_id, period_month);
-- usage_counters PK pivots from user-level to team-level. All metered ops now
-- share the team's pool regardless of which member triggered them.

-- ============================================================
-- 3. Backfill: create a personal team per existing auth.users,
--    move projects / subscriptions / usage_counters to it.
-- ============================================================

-- Personal team per user (idempotent via ON CONFLICT DO NOTHING-equivalent
-- — slug is UNIQUE and we derive it from the user id)
INSERT INTO teams (name, slug, personal, created_by)
SELECT
  COALESCE(
    NULLIF(u.raw_user_meta_data->>'full_name', ''),
    split_part(u.email, '@', 1),
    'Workspace'
  ) || '''s Workspace',
  'personal-' || substring(u.id::text, 1, 8),
  true,
  u.id
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM teams t WHERE t.created_by = u.id AND t.personal
);

-- Owner membership for every personal team
INSERT INTO team_members (team_id, user_id, role)
SELECT t.id, t.created_by, 'owner'
FROM teams t
WHERE t.personal
ON CONFLICT (team_id, user_id) DO NOTHING;

-- Move projects into their owner's personal team
UPDATE projects p
SET team_id = t.id
FROM teams t
WHERE t.personal AND t.created_by = p.user_id AND p.team_id IS NULL;

-- Move subscriptions similarly
UPDATE subscriptions s
SET team_id = t.id
FROM teams t
WHERE t.personal AND t.created_by = s.user_id AND s.team_id IS NULL;

-- Move usage counters
UPDATE usage_counters uc
SET team_id = t.id
FROM teams t
WHERE t.personal AND t.created_by = uc.user_id AND uc.team_id IS NULL;

-- Now that every project has a team_id, enforce it
ALTER TABLE projects ALTER COLUMN team_id SET NOT NULL;

-- Pivot usage_counters PK to (team_id, period_month, feature). Requires every
-- row to have team_id populated (done by the backfill above).
ALTER TABLE usage_counters ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE usage_counters DROP CONSTRAINT usage_counters_pkey;
ALTER TABLE usage_counters ADD PRIMARY KEY (team_id, period_month, feature);

-- Re-point the increment_usage RPC to take a team_id. Postgres won't let us
-- rename an input parameter via CREATE OR REPLACE, so drop the old (user-id)
-- signature first, then recreate with the new (team-id) signature.
DROP FUNCTION IF EXISTS public.increment_usage(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.increment_usage(
  p_team_id uuid,
  p_feature text,
  p_delta integer DEFAULT 1
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  -- user_id stays on the row as audit until the cleanup migration drops it;
  -- we pick the first owner of the team.
  SELECT user_id INTO v_user_id
  FROM team_members
  WHERE team_id = p_team_id AND role = 'owner'
  ORDER BY joined_at ASC
  LIMIT 1;

  INSERT INTO usage_counters (team_id, user_id, period_month, feature, count)
  VALUES (
    p_team_id,
    v_user_id,
    date_trunc('month', now())::date,
    p_feature,
    p_delta
  )
  ON CONFLICT (team_id, period_month, feature)
  DO UPDATE SET
    count = usage_counters.count + EXCLUDED.count,
    updated_at = now();
END;
$$;

-- ============================================================
-- 4. RLS on the new tables
-- ============================================================

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read own teams" ON teams
  FOR SELECT USING (
    id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid())
  );
-- Owners can update their team
CREATE POLICY "Owners update own team" ON teams
  FOR UPDATE USING (
    id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid() AND role = 'owner')
  );
-- Inserts happen via service_role from the backend (team creation route)

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read membership in own teams" ON team_members
  FOR SELECT USING (
    team_id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid())
  );
-- Inserts / deletes via service_role

ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners read invites for their teams" ON team_invites
  FOR SELECT USING (
    team_id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid() AND role = 'owner')
  );
-- Inserts / deletes / acceptance via service_role

-- ============================================================
-- 4b. Flip RLS on subscriptions + usage_counters to team membership.
--     (Project-scoped tables stay on user_id until the next migration —
--     the backend code rolls out first with dual-read support.)
-- ============================================================

DROP POLICY IF EXISTS "Users read own subscription" ON subscriptions;
CREATE POLICY "Team members read team subscription" ON subscriptions
  FOR SELECT USING (
    team_id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users read own usage" ON usage_counters;
CREATE POLICY "Team members read team usage" ON usage_counters
  FOR SELECT USING (
    team_id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid())
  );

-- ============================================================
-- 5. Signup trigger: auto-create personal team + owner membership
--    + free subscription on the team (replaces user-based subscription
--    creation from 20260417000003).
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_team_id uuid;
  display_name text;
BEGIN
  -- 1. profile
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name')
  ON CONFLICT (id) DO NOTHING;

  -- 2. personal team
  display_name := COALESCE(
    NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
    split_part(NEW.email, '@', 1),
    'Workspace'
  );
  INSERT INTO public.teams (name, slug, personal, created_by)
  VALUES (display_name || '''s Workspace', 'personal-' || substring(NEW.id::text, 1, 8), true, NEW.id)
  RETURNING id INTO new_team_id;

  -- 3. owner membership
  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (new_team_id, NEW.id, 'owner');

  -- 4. free subscription on the TEAM (dual-write user_id for backwards compat
  --    until RLS is flipped and user_id is dropped in a later cleanup)
  INSERT INTO public.subscriptions (user_id, team_id, plan_id, status)
  VALUES (NEW.id, new_team_id, 'free', 'active')
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;
