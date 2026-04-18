ALTER TABLE projects ADD COLUMN public_docs_chat_enabled boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN projects.public_docs_chat_enabled IS 'Auto-embed the chat widget on /docs/:projectId public pages';
