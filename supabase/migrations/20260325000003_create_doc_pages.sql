CREATE TABLE doc_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES doc_pages(id) ON DELETE SET NULL,
  title text NOT NULL,
  slug text NOT NULL,
  start_url text,
  goal text,
  status text NOT NULL DEFAULT 'draft',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(project_id, slug)
);

CREATE INDEX idx_doc_pages_project_id ON doc_pages(project_id);
CREATE INDEX idx_doc_pages_parent_id ON doc_pages(parent_id);
