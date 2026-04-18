-- Analytics: chat turn content + public-docs page views.
-- Backend inserts via service role (bypasses RLS). Owners read their own rows.

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_token text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  source text NOT NULL CHECK (source IN ('widget', 'public', 'app')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_messages_project_time ON chat_messages (project_id, created_at DESC);
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners read chat messages" ON chat_messages
  FOR SELECT USING (auth.uid() = user_id);

CREATE TABLE doc_page_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id uuid REFERENCES doc_pages(id) ON DELETE SET NULL,
  page_slug text NOT NULL,
  session_token text NOT NULL,
  source text NOT NULL CHECK (source IN ('public', 'app')),
  viewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_doc_page_views_project_time ON doc_page_views (project_id, viewed_at DESC);
ALTER TABLE doc_page_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners read doc views" ON doc_page_views
  FOR SELECT USING (auth.uid() = user_id);

COMMENT ON TABLE chat_messages IS 'Every chat turn (user + assistant) across widget/public/app — powers the Analytics tab';
COMMENT ON TABLE doc_page_views IS 'Public doc page view pings — powers the Analytics tab';
