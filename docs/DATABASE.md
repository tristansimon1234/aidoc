# Database Schema

## Tables

### projects
```sql
id                uuid PK DEFAULT gen_random_uuid()
user_id           uuid NOT NULL              -- auth.uid() via RLS
name              text NOT NULL
base_url          text NOT NULL
description       text
context           jsonb                      -- structured product context {audience, workflow, quirks}
credentials       jsonb                      -- [{label, username, password}]
discovered_context jsonb DEFAULT '{}'        -- AI-enriched product knowledge
created_at        timestamptz DEFAULT now()
updated_at        timestamptz DEFAULT now()
```
**RLS**: `auth.uid() = user_id` for ALL operations
**Index**: `idx_projects_user_id`

### doc_pages
```sql
id                uuid PK DEFAULT gen_random_uuid()
project_id        uuid NOT NULL FK → projects(id) CASCADE
parent_id         uuid FK → doc_pages(id) SET NULL
title             text NOT NULL
slug              text NOT NULL              -- unique per project
start_url         text                       -- where agent starts exploring
goal              text                       -- what the page should document
content           text                       -- editable markdown (source of truth for display)
custom_prompt     text                       -- user instructions for the agent (legacy)
briefing          jsonb                      -- structured briefing {objective, knowledge, resources[]}
status            text NOT NULL DEFAULT 'draft'  -- draft | exploring | published
sort_order        integer NOT NULL DEFAULT 0
created_at        timestamptz DEFAULT now()
updated_at        timestamptz DEFAULT now()
UNIQUE(project_id, slug)
```
**Indexes**: `idx_doc_pages_project_id`, `idx_doc_pages_parent_id`

### runs
```sql
id                       uuid PK DEFAULT gen_random_uuid()
feature_name             text NOT NULL
start_url                text NOT NULL
goal                     text NOT NULL
status                   text NOT NULL DEFAULT 'pending'  -- pending | running | blocked | completed | failed
token_usage              integer DEFAULT 0
browserbase_session_id   text                -- Browserbase session for resume
doc_page_id              uuid FK → doc_pages(id) SET NULL
summary_json             jsonb               -- structured exploration summary (sections, blockers, tryDocReport)
created_at               timestamptz DEFAULT now()
updated_at               timestamptz DEFAULT now()
```
**Index**: `idx_runs_doc_page_id`
**Note**: `summary_json.tryDocReport` stores the 7-section Try Doc analysis report (via `POST /runs/:id/analyze-try`)

### run_steps
```sql
id                uuid PK DEFAULT gen_random_uuid()
run_id            uuid NOT NULL FK → runs(id) CASCADE
step_index        integer NOT NULL
url               text
title             text                       -- semantic description (not tool name)
action            text                       -- what the agent did
observation       text                       -- agent reasoning (up to 8000 chars)
screenshot_path   text                       -- path in Supabase Storage
status            text DEFAULT 'completed'   -- completed | blocked | skipped
created_at        timestamptz DEFAULT now()
```
**Index**: `idx_run_steps_run_id`

### run_questions
```sql
id                uuid PK DEFAULT gen_random_uuid()
run_id            uuid NOT NULL FK → runs(id) CASCADE
step_id           uuid FK → run_steps(id) SET NULL
question          text NOT NULL
answer            text
answered_at       timestamptz
created_at        timestamptz DEFAULT now()
```
**Index**: `idx_run_questions_run_id`

### generated_docs
```sql
id                uuid PK DEFAULT gen_random_uuid()
run_id            uuid NOT NULL UNIQUE FK → runs(id) CASCADE
doc_page_id       uuid FK → doc_pages(id) SET NULL
markdown_content  text                       -- AI-generated markdown (immutable per generation)
json_content      jsonb                      -- self-assessment, gaps, suggestions
created_at        timestamptz DEFAULT now()
updated_at        timestamptz DEFAULT now()
```
**Index**: `idx_generated_docs_doc_page_id`

### artifacts
```sql
id                uuid PK DEFAULT gen_random_uuid()
run_id            uuid NOT NULL FK → runs(id) CASCADE
type              text NOT NULL              -- screenshot | trace | export
path              text NOT NULL              -- Supabase Storage path
created_at        timestamptz DEFAULT now()
```
**Index**: `idx_artifacts_run_id`

### plans
```sql
id                   text PRIMARY KEY           -- 'free' | 'startup' | 'growth' | 'business'
name                 text NOT NULL
price_cents          integer NOT NULL DEFAULT 0
currency             text NOT NULL DEFAULT 'EUR'
stripe_price_id      text                       -- populated when Stripe is enabled
max_projects         integer NOT NULL
max_doc_runs         integer NOT NULL
max_voiceovers       integer NOT NULL
max_try_doc          integer NOT NULL
max_widget_sessions  integer NOT NULL
sort_order           integer NOT NULL DEFAULT 0
features             jsonb NOT NULL DEFAULT '[]'  -- human-readable bullets for the UI
created_at           timestamptz DEFAULT now()
```
**RLS**: SELECT allowed to anyone (public pricing data).
**Seeded**: 4 rows — free / startup (49€) / growth (149€) / business (449€).

### subscriptions
```sql
id                      uuid PK DEFAULT gen_random_uuid()
user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
plan_id                 text NOT NULL DEFAULT 'free' REFERENCES plans(id)
status                  text NOT NULL DEFAULT 'active'   -- active | canceled | past_due | trialing
current_period_start    timestamptz
current_period_end      timestamptz
stripe_subscription_id  text                             -- populated when Stripe is enabled
cancel_at_period_end    boolean NOT NULL DEFAULT false
created_at              timestamptz DEFAULT now()
updated_at              timestamptz DEFAULT now()
```
**Partial unique index**: `subscriptions_active_user_idx` on `(user_id) WHERE status <> 'canceled'` — one active subscription per user.
**RLS**: `auth.uid() = user_id` for SELECT.
**Trigger**: `handle_new_user()` (shared with `profiles`) inserts a free subscription on signup; migration backfills existing users.

### usage_counters
```sql
user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
period_month  date NOT NULL
feature       text NOT NULL CHECK (feature IN ('doc_run','voiceover','try_doc','widget_sessions'))
count         integer NOT NULL DEFAULT 0
updated_at    timestamptz DEFAULT now()
PRIMARY KEY (user_id, period_month, feature)
```
**RLS**: SELECT `auth.uid() = user_id`.
**RPC**: `increment_usage(p_user_id, p_feature, p_delta)` — atomic `INSERT ... ON CONFLICT DO UPDATE`, SECURITY DEFINER. Called from backend services after each successful metered operation.

### chat_sessions
```sql
project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE
session_token  text NOT NULL             -- generated client-side, persisted in sessionStorage
period_month   date NOT NULL DEFAULT date_trunc('month', now())::date
user_id        uuid NOT NULL REFERENCES auth.users(id)   -- denormalized project owner
source         text NOT NULL DEFAULT 'widget' CHECK (source IN ('widget','app'))
started_at     timestamptz DEFAULT now()
last_seen_at   timestamptz DEFAULT now()
PRIMARY KEY (project_id, session_token, period_month)
```
**Index**: `idx_chat_sessions_last_seen`.
**RLS**: SELECT `auth.uid() = user_id`. Inserts via service_role only.
**Purpose**: deduplicates chat sessions (widget + in-app ChatPanel) per calendar month — only the first insert for a (project, token) in a month triggers a `chat_sessions` counter increment. `source` lets us split widget vs app traffic without affecting billing.

### profiles
```sql
id                 uuid PK REFERENCES auth.users(id) ON DELETE CASCADE
email              text
full_name          text
stripe_customer_id text                           -- populated once Stripe billing is enabled
created_at         timestamptz DEFAULT now()
updated_at         timestamptz DEFAULT now()
```
**RLS**: `auth.uid() = id` for SELECT and UPDATE
**Index**: `idx_profiles_stripe_customer_id`
**Trigger**: `on_auth_user_created` (AFTER INSERT on `auth.users`) → auto-creates a profile row via `handle_new_user()`.

### doc_embeddings
```sql
id                uuid PK DEFAULT gen_random_uuid()
project_id        uuid NOT NULL FK → projects(id) CASCADE
page_id           uuid NOT NULL FK → doc_pages(id) CASCADE
chunk_index       integer NOT NULL
chunk_text        text NOT NULL
embedding         vector(768) NOT NULL        -- pgvector, Gemini embedding model
page_title        text NOT NULL
page_slug         text NOT NULL
created_at        timestamptz DEFAULT now()
```
**Indexes**: `idx_doc_embeddings_project_id`, `idx_doc_embeddings_page_id`, `idx_doc_embeddings_vector` (HNSW, cosine)
**RLS**: Via `project_id → projects.user_id`
**Function**: `match_doc_chunks(project_id, embedding, match_count, threshold)` — cosine similarity search

### projects (additional columns added via migrations)
```sql
widget_api_key    text UNIQUE                 -- API key for embeddable widget
widget_enabled    boolean NOT NULL DEFAULT false
design            jsonb                       -- widget design config {logoUrl?: string, ...}
walkthrough_enabled boolean NOT NULL DEFAULT false  -- AI-guided walkthrough in widget
resources         jsonb                       -- [{type, label, value}] test resources for AI agent
mcp_api_key       text UNIQUE                 -- API key for the MCP server
mcp_enabled       boolean NOT NULL DEFAULT false
```
**Index**: `idx_projects_widget_api_key`

### doc_pages (additional columns added via migrations)
```sql
is_public         boolean NOT NULL DEFAULT false  -- per-page public sharing toggle
```

## Migrations (chronological)

| # | File | Description |
|---|------|-------------|
| 1 | `20260325000000_initial_schema.sql` | Core tables: runs, run_steps, run_questions, generated_docs, artifacts |
| 2 | `20260325000001_add_browserbase_session.sql` | Add browserbase_session_id to runs |
| 3 | `20260325000002_create_projects.sql` | Projects table with RLS |
| 4 | `20260325000003_create_doc_pages.sql` | Doc pages with hierarchy |
| 5 | `20260325000004_add_page_references.sql` | Link runs + generated_docs to doc_pages |
| 6 | `20260325000005_add_project_credentials.sql` | Add credentials jsonb to projects |
| 7 | `20260325000006_add_page_content.sql` | Add editable content to doc_pages |
| 8 | `20260325000007_add_page_custom_prompt.sql` | Add custom_prompt to doc_pages |
| 9 | `20260325000008_add_rls_all_tables.sql` | Enable RLS on all tables with ownership policies |
| 10 | `20260325000009_add_run_summary.sql` | Add summary_json to runs |
| 11 | `20260325000010_add_discovered_context.sql` | Add discovered_context to projects |
| 12 | `20260331000000_structured_project_context.sql` | Convert projects.context from text to jsonb |
| 13 | `20260331000001_add_page_briefing.sql` | Add briefing jsonb to doc_pages |
| 14 | `20260331000002_add_composite_run_index.sql` | Composite index on runs |
| 15 | `20260408000000_add_doc_embeddings.sql` | doc_embeddings table with pgvector for RAG chat |
| 16 | `20260408000001_add_widget_api_key.sql` | Widget API key + enabled flag on projects |
| 17 | `20260408000002_add_page_public.sql` | Add `is_public` boolean to doc_pages |
| 18 | `20260409000001_add_project_design.sql` | Add `design` JSONB to projects (widget customization) |
| 19 | `20260413000000_add_walkthrough_enabled.sql` | Add `walkthrough_enabled` to projects |
| 20 | `20260413000001_make_artifacts_bucket_public.sql` | Make artifacts storage bucket public |
| 21 | `20260416000000_add_project_resources.sql` | Add `resources` JSONB to projects (test resources) |
| 22 | `20260416000001_create_jobs_table.sql` | Background jobs table (voice-over, doc gen tracking) |
| 23 | `20260417000000_add_runs_project_id.sql` | Denormalize `project_id` on runs |
| 24 | `20260417000001_add_mcp_api_key.sql` | Add MCP API key + enabled flag to projects |
| 25 | `20260417000002_add_profiles_and_language.sql` | `profiles` table (1:1 with auth.users) + trigger to auto-create on signup |
| 26 | `20260417000003_add_plans_and_subscriptions.sql` | `plans` (seeded) + `subscriptions` (free by default) + trigger extension + backfill |
| 27 | `20260417000004_add_usage_tracking.sql` | `usage_counters` + `increment_usage` RPC + `widget_sessions` dedup table |
| 28 | `20260417000005_switch_to_token_usage.sql` | Replace per-feature quotas with a single `monthly_tokens` budget + opaque features |

## Relationships

```
projects 1:N doc_pages (CASCADE)
projects 1:N doc_embeddings (CASCADE)
doc_pages 1:N doc_pages (self-ref via parent_id, SET NULL)
doc_pages 1:N doc_embeddings (CASCADE)
doc_pages 1:N runs (via doc_page_id, SET NULL)
runs 1:N run_steps (CASCADE)
runs 1:N run_questions (CASCADE)
runs 1:1 generated_docs (CASCADE)
runs 1:N artifacts (CASCADE)
```

## Row Level Security (RLS)

All tables have RLS enabled. Policies chain through project ownership:

| Table | Policy | Logic |
|---|---|---|
| `projects` | Users see own projects | `auth.uid() = user_id` |
| `doc_pages` | Users access own project pages | `project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())` |
| `runs` | Users access own runs | Via `doc_page_id → doc_pages → projects.user_id` |
| `run_steps` | Users access own run steps | Via `run_id → runs → doc_pages → projects.user_id` |
| `run_questions` | Users access own questions | Via `run_id → runs → doc_pages → projects.user_id` |
| `generated_docs` | Users access own docs | Via `run_id → runs → doc_pages → projects.user_id` |
| `artifacts` | Users access own artifacts | Via `run_id → runs → doc_pages → projects.user_id` |

**Note**: The backend uses the Supabase **service key** which bypasses RLS. RLS protects direct client access. Page routes also verify ownership via `verifyProjectOwnership` middleware.

## Content Storage Strategy

- `generated_docs.markdown_content` = AI-generated output (immutable per generation)
- `doc_pages.content` = user's editable copy (source of truth for display)
- After AI generation → markdown auto-copied to `doc_pages.content`
- User edits `doc_pages.content` freely
- Re-exploring overwrites `doc_pages.content` with new AI output
