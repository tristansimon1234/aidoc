ALTER TABLE runs ADD COLUMN doc_page_id uuid REFERENCES doc_pages(id) ON DELETE SET NULL;
CREATE INDEX idx_runs_doc_page_id ON runs(doc_page_id);

ALTER TABLE generated_docs ADD COLUMN doc_page_id uuid REFERENCES doc_pages(id) ON DELETE SET NULL;
CREATE INDEX idx_generated_docs_doc_page_id ON generated_docs(doc_page_id);
