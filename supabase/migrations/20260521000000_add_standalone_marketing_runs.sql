-- Standalone marketing-video runs — runs that aren't backed by a doc page.
--
-- The marketing-video pipeline historically required a `doc_pages` row with
-- non-empty `content` to drive the script. To let users generate a promo
-- video without first writing documentation (sales / landing-page use case),
-- we introduce a `kind` column on `runs`:
--   - 'doc'             — default. The existing flow: page recording → doc.
--   - 'marketing-only'  — no page is linked; `brief` carries the input text
--                         the script generator uses instead of page.content.
--
-- `brief` is a free-text product description supplied at the project level.
-- Only populated when kind = 'marketing-only'; ignored otherwise. NULL by
-- default so the column adds zero cost to the 99% doc-flow rows.
--
-- Index on (project_id, kind, created_at desc) backs the project-level
-- list endpoint (`GET /api/projects/:pid/marketing-videos`) which filters
-- by kind and orders by creation time.

ALTER TABLE runs ADD COLUMN kind text NOT NULL DEFAULT 'doc';
ALTER TABLE runs ADD COLUMN brief text;

-- Constrain to known values — additions go through a migration so the
-- service contract stays the source of truth.
ALTER TABLE runs
  ADD CONSTRAINT runs_kind_check
  CHECK (kind IN ('doc', 'marketing-only'));

CREATE INDEX idx_runs_project_kind_created
  ON runs(project_id, kind, created_at DESC);
