-- Per-message classification populated at write time (fire-and-forget).
-- Enables UI filters ("show only negative") and a future frustration trendline
-- without re-running Gemini on every dashboard open.
ALTER TABLE chat_messages
  ADD COLUMN sentiment text CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  ADD COLUMN frustration_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN language text;

CREATE INDEX idx_chat_messages_project_sentiment
  ON chat_messages (project_id, sentiment)
  WHERE role = 'user' AND sentiment IS NOT NULL;

CREATE INDEX idx_chat_messages_project_frustrated
  ON chat_messages (project_id, created_at DESC)
  WHERE role = 'user' AND frustration_flag = true;

COMMENT ON COLUMN chat_messages.sentiment IS 'Classified at write-time on user messages only. NULL = not yet classified';
COMMENT ON COLUMN chat_messages.frustration_flag IS 'True when the user sounds irritated/stuck/blocked. User messages only.';
COMMENT ON COLUMN chat_messages.language IS '2-letter ISO code detected on the user message';
