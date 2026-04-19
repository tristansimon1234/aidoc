-- Track the creator of each page alongside the already-added
-- last_edited_* columns. Nullable because legacy pages predate this
-- and AI-generated pages don't have a human creator.

ALTER TABLE doc_pages
  ADD COLUMN created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
