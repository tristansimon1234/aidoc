-- Flip project-scoped RLS from "owner = auth.uid()" to "user is a member of
-- the project's team". Invited team members need read/write access to the
-- owner's projects; the original single-tenant policies filter them out.
--
-- Uses a SECURITY DEFINER helper to sidestep self-referential RLS on
-- team_members when building the user's team set.

CREATE OR REPLACE FUNCTION public.user_team_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT team_id FROM public.team_members WHERE user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.user_team_ids() TO authenticated;

-- team_members self-reference was the #1 reason invited users saw an empty
-- team: the old subquery `team_id IN (SELECT team_id FROM team_members WHERE
-- user_id = auth.uid())` recursed through its own RLS and returned zero rows.
DROP POLICY IF EXISTS "Members read membership in own teams" ON team_members;
CREATE POLICY "Members read membership in own teams" ON team_members
  FOR SELECT USING (team_id IN (SELECT user_team_ids()));

DROP POLICY IF EXISTS "Members read own teams" ON teams;
CREATE POLICY "Members read own teams" ON teams
  FOR SELECT USING (id IN (SELECT user_team_ids()));

DROP POLICY IF EXISTS "Owners update own team" ON teams;
CREATE POLICY "Owners update own team" ON teams
  FOR UPDATE USING (
    id IN (
      SELECT team_id FROM team_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
  );

DROP POLICY IF EXISTS "Owners read invites for their teams" ON team_invites;
CREATE POLICY "Owners read invites for their teams" ON team_invites
  FOR SELECT USING (
    team_id IN (
      SELECT team_id FROM team_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
  );

-- ============================================================
-- Project-scoped tables: shift every policy from "projects.user_id =
-- auth.uid()" to "projects.team_id IN user_team_ids()".
-- ============================================================

DROP POLICY IF EXISTS "Users see own projects" ON projects;
CREATE POLICY "Team members see team projects" ON projects
  FOR ALL USING (team_id IN (SELECT user_team_ids()))
  WITH CHECK (team_id IN (SELECT user_team_ids()));

DROP POLICY IF EXISTS "Users access own project pages" ON doc_pages;
CREATE POLICY "Team members access doc_pages" ON doc_pages
  FOR ALL USING (
    project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
  );

DROP POLICY IF EXISTS "Users access own runs" ON runs;
CREATE POLICY "Team members access runs" ON runs
  FOR ALL USING (
    (project_id IS NOT NULL AND project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids())))
    OR doc_page_id IN (
      SELECT id FROM doc_pages
      WHERE project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
    )
  );

DROP POLICY IF EXISTS "Users access own run steps" ON run_steps;
CREATE POLICY "Team members access run_steps" ON run_steps
  FOR ALL USING (
    run_id IN (
      SELECT id FROM runs
      WHERE (project_id IS NOT NULL AND project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids())))
         OR doc_page_id IN (
           SELECT id FROM doc_pages
           WHERE project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
         )
    )
  );

DROP POLICY IF EXISTS "Users access own run questions" ON run_questions;
CREATE POLICY "Team members access run_questions" ON run_questions
  FOR ALL USING (
    run_id IN (
      SELECT id FROM runs
      WHERE (project_id IS NOT NULL AND project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids())))
         OR doc_page_id IN (
           SELECT id FROM doc_pages
           WHERE project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
         )
    )
  );

DROP POLICY IF EXISTS "Users access own generated docs" ON generated_docs;
CREATE POLICY "Team members access generated_docs" ON generated_docs
  FOR ALL USING (
    (run_id IS NOT NULL AND run_id IN (
      SELECT id FROM runs
      WHERE (project_id IS NOT NULL AND project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids())))
         OR doc_page_id IN (
           SELECT id FROM doc_pages
           WHERE project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
         )
    ))
    OR (doc_page_id IS NOT NULL AND doc_page_id IN (
      SELECT id FROM doc_pages WHERE project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
    ))
  );

DROP POLICY IF EXISTS "Users access own artifacts" ON artifacts;
CREATE POLICY "Team members access artifacts" ON artifacts
  FOR ALL USING (
    run_id IN (
      SELECT id FROM runs
      WHERE (project_id IS NOT NULL AND project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids())))
         OR doc_page_id IN (
           SELECT id FROM doc_pages
           WHERE project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
         )
    )
  );

DROP POLICY IF EXISTS "Users manage own jobs" ON jobs;
CREATE POLICY "Team members manage jobs" ON jobs
  FOR ALL USING (
    project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
  );

DROP POLICY IF EXISTS "owners read chat messages" ON chat_messages;
CREATE POLICY "Team members read chat messages" ON chat_messages
  FOR SELECT USING (
    project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
  );

DROP POLICY IF EXISTS "owners read doc views" ON doc_page_views;
CREATE POLICY "Team members read doc views" ON doc_page_views
  FOR SELECT USING (
    project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
  );

-- doc_embeddings had RLS added in its own migration; same treatment.
-- (Policy name varies by repo; guard with IF EXISTS for both possibilities.)
DROP POLICY IF EXISTS "Users access own doc embeddings" ON doc_embeddings;
DROP POLICY IF EXISTS "Team members access doc embeddings" ON doc_embeddings;
CREATE POLICY "Team members access doc embeddings" ON doc_embeddings
  FOR ALL USING (
    project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
  );

DROP POLICY IF EXISTS "Users read own chat sessions" ON chat_sessions;
CREATE POLICY "Team members read chat sessions" ON chat_sessions
  FOR SELECT USING (
    project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
  );
