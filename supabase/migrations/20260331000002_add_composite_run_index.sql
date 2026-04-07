CREATE INDEX IF NOT EXISTS idx_runs_latest_by_page ON runs(doc_page_id, created_at DESC);
