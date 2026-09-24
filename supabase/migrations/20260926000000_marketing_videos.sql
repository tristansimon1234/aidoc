-- Vidéos marketing : une création est soit une SOP, soit une vidéo marketing courte
-- (brief, durée visée 30 ou 60 s, musique de fond en option).
alter table public.sops add column if not exists kind text not null default 'sop'
  check (kind in ('sop', 'marketing'));
alter table public.sops add column if not exists brief text;
alter table public.sops add column if not exists target_seconds integer not null default 60;
alter table public.sops add column if not exists music boolean not null default false;
