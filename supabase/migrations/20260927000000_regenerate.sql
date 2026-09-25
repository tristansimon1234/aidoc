-- Régénération : l'utilisateur corrige un résultat avec un retour écrit ; chaque régénération est payée.
-- `revision` compte les générations (0 = la première) et rend uniques les débits / remboursements.
alter table public.sops add column if not exists feedback text;
alter table public.sops add column if not exists revision integer not null default 0;
