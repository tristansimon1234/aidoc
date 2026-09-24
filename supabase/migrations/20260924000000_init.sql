-- Doclee v2 — schéma complet (repart de zéro).
-- 3 tables : accounts (solde de crédits), sops (une vidéo → une SOP), credit_events (journal).
-- Le navigateur ne lit rien en direct : tout passe par le serveur (clé service).
-- RLS activée sans policy = accès refusé pour les clés anon/authenticated.

create table public.accounts (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  credits            integer not null default 0 check (credits >= 0),
  stripe_customer_id text unique,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.sops (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users (id) on delete cascade,
  title                text not null,
  language             text not null default 'fr',
  voice                text not null default 'standard' check (voice in ('none', 'standard', 'premium')),
  status               text not null default 'uploading'
                         check (status in ('uploading', 'processing', 'ready', 'failed')),
  progress             text,
  error                text,
  credits_used         integer not null default 0,
  source_path          text not null,
  duration_seconds     numeric,
  markdown             text,
  video_path           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index sops_user_created_idx on public.sops (user_id, created_at desc);

-- Journal des crédits : +10 (achat), -2 (SOP), +2 (remboursement échec)…
-- `ref` unique = idempotence des webhooks Stripe (un évènement rejoué ne crédite pas deux fois).
create table public.credit_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  delta      integer not null,
  reason     text not null,
  ref        text unique,
  created_at timestamptz not null default now()
);
create index credit_events_user_idx on public.credit_events (user_id, created_at desc);

alter table public.accounts enable row level security;
alter table public.sops enable row level security;
alter table public.credit_events enable row level security;

-- 1 crédit offert à l'inscription.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.accounts (user_id, credits) values (new.id, 1);
  insert into public.credit_events (user_id, delta, reason) values (new.id, 1, 'welcome');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Ajoute (ou retire, delta < 0) des crédits de façon atomique.
-- Retourne false si le solde est insuffisant ou si `p_ref` a déjà été traité.
create function public.apply_credits(p_user uuid, p_delta integer, p_reason text, p_ref text default null)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_ref is not null and exists (select 1 from credit_events where ref = p_ref) then
    return false;
  end if;

  update accounts
     set credits = credits + p_delta, updated_at = now()
   where user_id = p_user and credits + p_delta >= 0;
  if not found then
    return false;
  end if;

  insert into credit_events (user_id, delta, reason, ref) values (p_user, p_delta, p_reason, p_ref);
  return true;
end $$;

revoke execute on function public.apply_credits(uuid, integer, text, text) from public, anon, authenticated;

-- Stockage : vidéos sources, captures et vidéos narrées.
-- Bucket public (chemins non devinables : <user>/<sop uuid>/…) pour que les images
-- collées dans Notion / Google Docs restent affichées.
insert into storage.buckets (id, name, public, file_size_limit)
values ('sops', 'sops', true, 2147483648)
on conflict (id) do nothing;
