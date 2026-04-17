-- Separate MCP API key for documentation MCP server (independent from widget)
ALTER TABLE projects ADD COLUMN mcp_api_key text UNIQUE;
ALTER TABLE projects ADD COLUMN mcp_enabled boolean NOT NULL DEFAULT false;

CREATE INDEX idx_projects_mcp_api_key ON projects(mcp_api_key) WHERE mcp_api_key IS NOT NULL;
