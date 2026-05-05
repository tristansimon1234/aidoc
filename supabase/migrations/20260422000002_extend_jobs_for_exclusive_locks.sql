-- Extend the `jobs` table so every heavy action (exploration, doc-gen,
-- voice-over, try-doc analysis, project re-index) can route through the
-- same exclusivity lock.
--
-- Why: the existing UNIQUE index `(page_id, type) WHERE status='running'`
-- already blocks concurrent duplicates for page-scoped jobs, but (1) only
-- two routes actually create a job today (analyze-video→doc-gen, voiceover),
-- (2) page_id is NOT NULL so project-scoped jobs (indexing) can't use the
-- table, and (3) the row doesn't carry the user that triggered it, so the
-- blocked caller can't see "Alice started this 2 min ago".
--
-- Changes:
--   - `triggered_by_user_id` → who clicked the button. Lets the 409 payload
--     enrich "Someone is running this" with an actual display name.
--   - `page_id` becomes nullable so project-level jobs (index) can exist
--     without a specific page. The existing page-scoped UNIQUE index is
--     already partial on `status='running'`; a NULL page_id simply sits
--     outside that index.
--   - New partial UNIQUE index on `(project_id, type) WHERE status='running'
--     AND page_id IS NULL` — provides the same exclusivity guarantee for
--     project-scoped jobs.
--
-- The existing `type` column has no CHECK constraint, so new types
-- (`exploration`, `try-doc-analysis`, `index`) don't need a schema change.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS triggered_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE jobs ALTER COLUMN page_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_project_type_running
  ON jobs(project_id, type)
  WHERE status = 'running' AND page_id IS NULL;

-- Optional index on triggered_by for the admin "who's running what" view.
CREATE INDEX IF NOT EXISTS idx_jobs_triggered_by ON jobs(triggered_by_user_id) WHERE triggered_by_user_id IS NOT NULL;

COMMENT ON COLUMN jobs.triggered_by_user_id IS 'User who kicked off the job. Null for jobs created before this column, or when the backend runs server-side (cron, webhooks).';
COMMENT ON COLUMN jobs.page_id IS 'Nullable for project-scoped jobs (index). Page-scoped jobs still use the UNIQUE partial index on (page_id, type) for exclusivity.';
