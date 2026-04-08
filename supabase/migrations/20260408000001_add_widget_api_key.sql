-- Add widget API key for embeddable chat widget
alter table projects
  add column widget_api_key text unique,
  add column widget_enabled boolean not null default false;

create index idx_projects_widget_api_key on projects(widget_api_key);
