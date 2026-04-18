ALTER TABLE projects ADD COLUMN archived_at timestamptz;
COMMENT ON COLUMN projects.archived_at IS 'Null = active, timestamp = when the project was archived';
CREATE INDEX IF NOT EXISTS idx_projects_user_archived ON projects (user_id, archived_at);
