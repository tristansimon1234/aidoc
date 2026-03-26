-- Enable RLS on doc_pages
ALTER TABLE doc_pages ENABLE ROW LEVEL SECURITY;

-- Policy: users can only access pages in their own projects
CREATE POLICY "Users access own project pages" ON doc_pages
  FOR ALL USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

-- Enable RLS on runs (via doc_page_id → project ownership)
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;

-- Runs linked to a page: check project ownership
-- Runs without a page (legacy): allow for now
CREATE POLICY "Users access own runs" ON runs
  FOR ALL USING (
    doc_page_id IS NULL
    OR doc_page_id IN (
      SELECT dp.id FROM doc_pages dp
      JOIN projects p ON dp.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

-- Enable RLS on run_steps
ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users access own run steps" ON run_steps
  FOR ALL USING (
    run_id IN (SELECT id FROM runs WHERE doc_page_id IS NULL OR doc_page_id IN (
      SELECT dp.id FROM doc_pages dp JOIN projects p ON dp.project_id = p.id WHERE p.user_id = auth.uid()
    ))
  );

-- Enable RLS on run_questions
ALTER TABLE run_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users access own run questions" ON run_questions
  FOR ALL USING (
    run_id IN (SELECT id FROM runs WHERE doc_page_id IS NULL OR doc_page_id IN (
      SELECT dp.id FROM doc_pages dp JOIN projects p ON dp.project_id = p.id WHERE p.user_id = auth.uid()
    ))
  );

-- Enable RLS on generated_docs
ALTER TABLE generated_docs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users access own generated docs" ON generated_docs
  FOR ALL USING (
    run_id IN (SELECT id FROM runs WHERE doc_page_id IS NULL OR doc_page_id IN (
      SELECT dp.id FROM doc_pages dp JOIN projects p ON dp.project_id = p.id WHERE p.user_id = auth.uid()
    ))
  );

-- Enable RLS on artifacts
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users access own artifacts" ON artifacts
  FOR ALL USING (
    run_id IN (SELECT id FROM runs WHERE doc_page_id IS NULL OR doc_page_id IN (
      SELECT dp.id FROM doc_pages dp JOIN projects p ON dp.project_id = p.id WHERE p.user_id = auth.uid()
    ))
  );
