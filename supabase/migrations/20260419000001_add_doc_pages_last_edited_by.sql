-- Track who last edited each doc page. Used by the UI to surface a
-- "Edited by Alice, 2h ago" line in the page header — the minimum social
-- signal that the workspace is shared, without full collab/comments.
--
-- Nullable because legacy rows predate the column and the AI-generated
-- docs are authored by the system, not a user.

ALTER TABLE doc_pages
  ADD COLUMN last_edited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN last_edited_at timestamptz;

CREATE INDEX idx_doc_pages_last_edited_at ON doc_pages (project_id, last_edited_at DESC)
  WHERE last_edited_at IS NOT NULL;
