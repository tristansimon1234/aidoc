-- Add design JSONB column to projects for visual customization
-- Applies to both the embeddable widget and public documentation pages
ALTER TABLE projects ADD COLUMN design jsonb DEFAULT NULL;

COMMENT ON COLUMN projects.design IS 'Visual design config: {accentColor, bgColor, textColor, font}';
