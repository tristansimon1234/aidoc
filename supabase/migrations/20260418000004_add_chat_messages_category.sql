-- Per-message category classified at write-time. Lets the Analytics tab
-- compute pain-point buckets in pure SQL (GROUP BY category) without a
-- read-time LLM pass.
ALTER TABLE chat_messages
  ADD COLUMN category text CHECK (category IN (
    'onboarding', 'pricing', 'how-to', 'error', 'integration', 'account', 'other'
  ));

CREATE INDEX idx_chat_messages_project_category
  ON chat_messages (project_id, category)
  WHERE role = 'user' AND category IS NOT NULL;

COMMENT ON COLUMN chat_messages.category IS 'Intent category classified at write time. User messages only.';
