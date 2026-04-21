-- Snapshot slot for undoing a destructive doc regeneration.
--
-- When a video-to-doc generation run overwrites doc_pages.content, we copy
-- the previous content into these columns first. A single-level history is
-- enough to recover from an accidental "regenerate" click; when the user
-- regenerates twice, the oldest snapshot is dropped (keep-latest-only). A
-- restore endpoint moves previous_* back into content / content_blocks and
-- clears the snapshot.

ALTER TABLE doc_pages ADD COLUMN previous_content text;
ALTER TABLE doc_pages ADD COLUMN previous_content_blocks jsonb;
ALTER TABLE doc_pages ADD COLUMN previous_content_saved_at timestamptz;
