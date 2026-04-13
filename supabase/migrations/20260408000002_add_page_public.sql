-- Add per-page public toggle for sharing
alter table doc_pages add column is_public boolean not null default false;
