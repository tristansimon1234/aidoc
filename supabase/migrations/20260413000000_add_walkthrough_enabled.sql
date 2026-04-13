ALTER TABLE projects ADD COLUMN walkthrough_enabled boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN projects.walkthrough_enabled IS 'Enable AI-guided walkthrough in the embedded widget';
