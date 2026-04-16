-- Add resources column to projects table (JSONB array of test resources)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS resources jsonb DEFAULT '[]';
