-- =============================================================================
-- Doclee — Supabase RLS audit
-- =============================================================================
-- Run this from the Supabase SQL editor (project → SQL Editor → New query →
-- paste → Run). Read-only — produces 6 sections you scroll through. The whole
-- thing is "show me what an attacker holding only my VITE_SUPABASE_ANON_KEY
-- can read or write".
--
-- The exposed surface from the browser is:
--   - role anon       (no JWT, just the anon key)
--   - role authenticated  (any signed-in user, even one who just registered)
--
-- service_role is server-only (SUPABASE_SERVICE_KEY env var) and bypasses RLS
-- entirely — that role MUST never appear in a frontend bundle. Section 6
-- reminds you to grep for that.
--
-- What "ok" looks like:
--   1. zero rows in §1 (every public table has RLS enabled)
--   2. zero rows in §2 (no policies allowing the world)
--   3. each row in §3 makes sense (e.g. plans table is intentionally readable)
--   4. zero rows in §4 (no FORCE-disabled buckets if you store private data)
--   5. §5 is informational
-- =============================================================================


-- §1. Tables in public schema with RLS DISABLED ───────────────────────────────
-- An attacker with the anon key can SELECT/INSERT/UPDATE/DELETE on any row of
-- any table here. Should always be empty for tables holding user data.
select
  '⚠ NO RLS' as severity,
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass)) as size
from pg_tables
where schemaname = 'public'
  and rowsecurity = false
order by pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass) desc;


-- §2. Policies that grant unconditional access (USING / WITH CHECK = true) ───
-- A policy with `using (true)` lets ANYONE in the role read; same for
-- `with check (true)` on writes. Sometimes intentional (a public "plans"
-- catalog). Always intentional means you reviewed each row below and you're
-- ok with anon seeing it.
select
  '⚠ OPEN POLICY' as severity,
  schemaname,
  tablename,
  policyname,
  array_to_string(roles, ', ') as roles,
  cmd as command,
  qual as using_clause,
  with_check
from pg_policies
where schemaname = 'public'
  and (
    qual = 'true'
    or with_check = 'true'
    or qual is null and cmd in ('INSERT', 'UPDATE', 'DELETE')  -- no using = always true on writes
  )
order by tablename, policyname;


-- §3. Every public-schema policy, grouped — eyeball-audit list ────────────────
-- Skim this. For each row, ask: "should the listed roles be able to do this
-- command on this table given this clause?". Most rows should reference
-- auth.uid(), team_members membership, or a domain check.
select
  schemaname,
  tablename,
  policyname,
  array_to_string(roles, ', ') as roles,
  cmd as command,
  coalesce(qual, '∅') as using_clause,
  coalesce(with_check, '∅') as with_check_clause
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;


-- §4. Storage buckets — public vs private ─────────────────────────────────────
-- Public buckets: anyone with the URL gets the file (CDN-style). Fine for
-- rendered marketing videos, voice-overs, public screenshots. NOT fine for
-- private exports, paid content, internal docs. Anything you'd be ok seeing
-- on a tweet should be public; everything else should be private + signed URLs.
select
  id as bucket,
  case when public then '🌐 PUBLIC' else '🔒 private' end as visibility,
  file_size_limit,
  array_to_string(allowed_mime_types, ', ') as allowed_mimes,
  created_at
from storage.buckets
order by public desc, id;


-- §5. Tables exposed via PostgREST (pg_publication / GRANTed) ─────────────────
-- This is what the anon role can actually try to query. RLS still gates the
-- response, but if a table you THOUGHT was internal shows up here, it's at
-- least pingable from the browser — which means a permissive policy turns
-- into a leak instantly.
select
  table_schema,
  table_name,
  privilege_type,
  grantee
from information_schema.role_table_grants
where grantee in ('anon', 'authenticated')
  and table_schema = 'public'
order by table_name, grantee, privilege_type;


-- §6. Functions invokable by anon / authenticated ─────────────────────────────
-- RPCs (`rpc('foo')`) the browser can call. SECURITY DEFINER functions
-- BYPASS RLS — those are the highest-risk surface. Each one needs to do its
-- own auth check at the top of the function body.
select
  n.nspname as schema,
  p.proname as function,
  pg_get_function_identity_arguments(p.oid) as args,
  case p.prosecdef when true then '⚠ SECURITY DEFINER (bypasses RLS)' else 'invoker' end as security,
  array_to_string(p.proacl::text[], ', ') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (
    has_function_privilege('anon', p.oid, 'EXECUTE')
    or has_function_privilege('authenticated', p.oid, 'EXECUTE')
  )
order by p.prosecdef desc, p.proname;


-- =============================================================================
-- After running, ALSO do these from your shell (not in SQL editor):
--
-- Confirm service_role isn't in the frontend bundle:
--   grep -r "service_role\|SUPABASE_SERVICE_KEY\|SERVICE_ROLE_KEY" \
--     dist/client/ src/ui/ 2>/dev/null | grep -v "// "
--   → should return nothing.
--
-- Confirm only VITE_ vars reach the bundle:
--   grep -rE "VITE_SUPABASE_(URL|ANON_KEY)" src/ui/ | head
--   → those two only. No other VITE_SUPABASE_* keys.
-- =============================================================================
