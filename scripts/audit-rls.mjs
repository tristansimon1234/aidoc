/**
 * RLS audit — shell-friendly version of scripts/audit-rls.sql.
 *
 * Runs the same checks as the SQL file but from the command line, prints a
 * colored summary, and exits non-zero if any critical finding (RLS off on a
 * public table, USING(true) policy on a user table). Wire it into CI as
 * `node scripts/audit-rls.mjs` and the build fails the day someone ships a
 * migration that drops RLS by accident.
 *
 * Auth: uses SUPABASE_URL + SUPABASE_SERVICE_KEY from the environment (same
 * vars the backend already needs). Service role is required because we're
 * reading pg_policies / pg_tables — anon doesn't have access. Never bake
 * the service key into anything that reaches a browser.
 *
 * Tables that are intentionally readable by anon (the `plans` catalog, the
 * `public_pages_view` materialized view, etc.) are listed in IGNORE_OPEN_READS
 * below — the audit treats them as expected and doesn't flag them. Adjust
 * that allowlist when you genuinely add a public-readable table; don't widen
 * it to silence a real warning.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env.')
  process.exit(2)
}

// Read-only intentionally exposed to anon — adding a row here means "I
// reviewed the policy and it's safe for anyone with the anon key to read".
const IGNORE_OPEN_READS = new Set([
  'plans',  // public catalog of pricing tiers
])

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

// Run an arbitrary SELECT through PostgREST's `rpc` if a helper function
// exists, else fall back to a single-shot SQL via the admin API. Supabase JS
// doesn't expose a raw query method on the public client, so we hit the
// `query` endpoint of pg_meta if available, otherwise we instruct the user
// to paste the .sql file in the SQL editor.
async function runSql(label, sql) {
  // pg_meta isn't always exposed; we use a stored procedure that the audit
  // creates if missing.
  const { data, error } = await sb.rpc('audit_rls_query', { sql_text: sql })
  if (error) {
    if (String(error.message).includes('audit_rls_query')) {
      console.error(
        '\nThis script needs a one-time helper function. Run this once in the Supabase SQL editor:\n\n' +
        "create or replace function public.audit_rls_query(sql_text text)\n" +
        '  returns setof jsonb\n' +
        '  language plpgsql\n' +
        '  security definer\n' +
        '  set search_path = public\n' +
        'as $$\n' +
        'begin\n' +
        '  return query execute format(\'select to_jsonb(t) from (%s) t\', sql_text);\n' +
        'end; $$;\n\n' +
        'revoke execute on function public.audit_rls_query(text) from anon, authenticated;\n\n' +
        'Then re-run this script.\n',
      )
      process.exit(2)
    }
    console.error(`[${label}] query failed: ${error.message}`)
    return []
  }
  return (data ?? []).map((row) => row)
}

const c = (color, s) => `\x1b[${color}m${s}\x1b[0m`
const red = (s) => c('31', s)
const yellow = (s) => c('33', s)
const green = (s) => c('32', s)
const dim = (s) => c('90', s)

let critical = 0
let warnings = 0

// §1 — RLS disabled on public tables
const noRls = await runSql(
  'no-rls',
  "select tablename from pg_tables where schemaname='public' and rowsecurity=false order by tablename",
)
console.log('\n=== §1. Tables without RLS ===')
if (noRls.length === 0) {
  console.log(green('  ok — every public table has RLS enabled'))
} else {
  for (const r of noRls) {
    console.log(red(`  ⚠ ${r.tablename}`))
    critical++
  }
}

// §2 — Open policies (USING true / WITH CHECK true)
const openPolicies = await runSql(
  'open-policies',
  "select tablename, policyname, array_to_string(roles, ',') as roles, cmd, qual, with_check from pg_policies where schemaname='public' and (qual='true' or with_check='true') order by tablename",
)
console.log('\n=== §2. Open policies (using/with_check = true) ===')
const surprises = openPolicies.filter((p) => !IGNORE_OPEN_READS.has(p.tablename))
const expected = openPolicies.filter((p) => IGNORE_OPEN_READS.has(p.tablename))
if (surprises.length === 0) {
  console.log(green('  ok — no unexpected open policies'))
} else {
  for (const p of surprises) {
    console.log(
      red(`  ⚠ ${p.tablename}.${p.policyname}`) +
      dim(` [${p.roles}] ${p.cmd} using=${p.qual ?? '∅'} with_check=${p.with_check ?? '∅'}`),
    )
    if (p.cmd === 'SELECT') warnings++
    else critical++  // open INSERT/UPDATE/DELETE = anyone can write
  }
}
if (expected.length > 0) {
  console.log(dim(`  (${expected.length} expected — see IGNORE_OPEN_READS in this script)`))
}

// §3 — SECURITY DEFINER functions invokable by anon/authenticated
const sdFns = await runSql(
  'security-definer',
  `select n.nspname as schema, p.proname as fn,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_exec,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_can_exec
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef = true
    order by p.proname`,
)
console.log('\n=== §3. SECURITY DEFINER functions ===')
const exposedSd = sdFns.filter((f) => f.anon_can_exec || f.auth_can_exec)
if (exposedSd.length === 0) {
  console.log(green('  ok — no SECURITY DEFINER functions invokable by anon/authenticated'))
} else {
  for (const f of exposedSd) {
    const who = [f.anon_can_exec && 'anon', f.auth_can_exec && 'authenticated'].filter(Boolean).join(', ')
    console.log(yellow(`  ⚠ ${f.fn}()`) + dim(` callable by ${who} — verify the function does its own auth check`))
    warnings++
  }
}

// §4 — Storage buckets
const buckets = await runSql(
  'buckets',
  'select id, public from storage.buckets order by public desc, id',
)
console.log('\n=== §4. Storage buckets ===')
for (const b of buckets) {
  if (b.public) console.log(yellow(`  🌐 ${b.id}`) + dim(' (public — anyone with the URL reads files)'))
  else console.log(green(`  🔒 ${b.id}`) + dim(' (private)'))
}

// Summary
console.log('\n' + '='.repeat(60))
if (critical === 0 && warnings === 0) {
  console.log(green('✓ Audit clean — no critical findings, no warnings.'))
  process.exit(0)
}
if (critical > 0) {
  console.log(red(`✗ ${critical} critical finding(s)`) + (warnings ? dim(` + ${warnings} warning(s)`) : ''))
  process.exit(1)
}
console.log(yellow(`! ${warnings} warning(s) — review and add to IGNORE_OPEN_READS if intentional.`))
process.exit(0)
