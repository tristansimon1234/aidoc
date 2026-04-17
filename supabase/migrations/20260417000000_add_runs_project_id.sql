-- Add project_id to runs for direct project-level queries (usage, analytics)
-- Without this, deleting a page loses the token usage data (doc_page_id SET NULL)

ALTER TABLE runs ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE SET NULL;

-- Backfill from existing doc_page_id → doc_pages.project_id
UPDATE runs SET project_id = dp.project_id
FROM doc_pages dp
WHERE runs.doc_page_id = dp.id AND runs.project_id IS NULL;

CREATE INDEX idx_runs_project_id ON runs(project_id);
