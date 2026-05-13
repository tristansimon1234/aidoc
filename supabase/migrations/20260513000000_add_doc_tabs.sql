-- doc_tabs — top-level grouping above the page tree.
-- Each project always has at least one tab ("main"). Pages belong to
-- exactly one tab; the same slug can be reused across tabs in the same
-- project (page slug uniqueness becomes scoped by (project_id, tab_id)).
--
-- Existing projects + pages are migrated into a default "main" tab so
-- nothing breaks. Public docs frontend redirects old flat URLs
-- (/docs/<project>/<page>) to the canonical /docs/<project>/main/<page>.

-- --- doc_tabs table ---------------------------------------------------

CREATE TABLE doc_tabs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  -- Slug unique within a project so URLs don't collide.
  UNIQUE (project_id, slug)
);

CREATE INDEX idx_doc_tabs_project_id ON doc_tabs(project_id);
CREATE INDEX idx_doc_tabs_project_sort ON doc_tabs(project_id, sort_order);

ALTER TABLE doc_tabs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members access doc_tabs" ON doc_tabs
  FOR ALL USING (
    project_id IN (SELECT id FROM projects WHERE team_id IN (SELECT user_team_ids()))
  );

-- --- Seed the default "main" tab for every existing project ----------

INSERT INTO doc_tabs (project_id, name, slug, sort_order)
SELECT id, 'main', 'main', 0 FROM projects;

-- --- doc_pages.tab_id column -----------------------------------------

ALTER TABLE doc_pages ADD COLUMN tab_id uuid;

-- Backfill: every existing page belongs to its project's "main" tab.
UPDATE doc_pages p
SET tab_id = t.id
FROM doc_tabs t
WHERE t.project_id = p.project_id AND t.slug = 'main';

-- All rows backfilled — make the column required + FK + indexed.
-- ON DELETE CASCADE matches the project-wide cascade semantics:
-- destroying a tab destroys its pages (the API layer requires moving
-- pages out first, so this only fires on full project deletion).
ALTER TABLE doc_pages ALTER COLUMN tab_id SET NOT NULL;
ALTER TABLE doc_pages
  ADD CONSTRAINT doc_pages_tab_id_fkey
  FOREIGN KEY (tab_id) REFERENCES doc_tabs(id) ON DELETE CASCADE;

CREATE INDEX idx_doc_pages_tab_id ON doc_pages(tab_id);

-- Slug uniqueness moves from (project, slug) to (project, tab, slug):
-- pages in different tabs can share a slug. We keep project_id in the
-- key so a quick (project, slug) lookup still hits a single index.
ALTER TABLE doc_pages DROP CONSTRAINT IF EXISTS doc_pages_project_id_slug_key;
ALTER TABLE doc_pages
  ADD CONSTRAINT doc_pages_project_tab_slug_key
  UNIQUE (project_id, tab_id, slug);

-- --- updated_at trigger for doc_tabs ---------------------------------
-- Reuse the existing set_updated_at() function if present; otherwise
-- inline the trigger function. We don't assume — emit an idempotent
-- definition that doesn't conflict if a project-wide updated_at
-- function already exists.
CREATE OR REPLACE FUNCTION doc_tabs_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER doc_tabs_updated_at
BEFORE UPDATE ON doc_tabs
FOR EACH ROW EXECUTE FUNCTION doc_tabs_set_updated_at();
