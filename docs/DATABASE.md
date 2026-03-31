# Database Schema

## Tables

### projects
```sql
id                uuid PK DEFAULT gen_random_uuid()
user_id           uuid NOT NULL              -- auth.uid() via RLS
name              text NOT NULL
base_url          text NOT NULL
description       text
context           text                       -- product context for AI prompts
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
custom_prompt     text                       -- user instructions for the agent
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
summary_json             jsonb               -- structured exploration summary (sections, blockers)
created_at               timestamptz DEFAULT now()
updated_at               timestamptz DEFAULT now()
```
**Index**: `idx_runs_doc_page_id`

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

## Relationships

```
projects 1:N doc_pages (CASCADE)
doc_pages 1:N doc_pages (self-ref via parent_id, SET NULL)
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
