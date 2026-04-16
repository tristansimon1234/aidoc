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

CREATE INDEX idx_jobs_project_id ON jobs(project_id);
CREATE INDEX idx_jobs_page_id ON jobs(page_id);

-- RLS: users see jobs for their own projects
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own jobs"
  ON jobs FOR ALL
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));
