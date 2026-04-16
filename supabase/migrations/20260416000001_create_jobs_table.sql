-- Background jobs table — tracks long-running operations (doc-gen, voiceover, try-doc)
-- Survives browser refresh, works across tabs, queryable by frontend via polling.

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES doc_pages(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type text NOT NULL,                          -- 'doc-gen' | 'voiceover' | 'try-doc'
  status text NOT NULL DEFAULT 'running',      -- running | completed | failed
  error text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX idx_jobs_project_id ON jobs(project_id);
CREATE INDEX idx_jobs_run_id ON jobs(run_id);
CREATE INDEX idx_jobs_status ON jobs(status) WHERE status = 'running';

-- Prevent duplicate running jobs for the same page + type
CREATE UNIQUE INDEX idx_jobs_page_type_running ON jobs(page_id, type) WHERE status = 'running';

-- RLS: users see jobs for their own projects
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own jobs"
  ON jobs FOR ALL
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- Auto-cleanup: delete completed/failed jobs older than 24h
CREATE OR REPLACE FUNCTION cleanup_old_jobs() RETURNS trigger AS $$
BEGIN
  DELETE FROM jobs WHERE status IN ('completed', 'failed') AND updated_at < now() - interval '24 hours';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cleanup_old_jobs
  AFTER INSERT ON jobs
  FOR EACH STATEMENT
  EXECUTE FUNCTION cleanup_old_jobs();
