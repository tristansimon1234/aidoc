# Database Schema

## Tables

### projects
```sql
id                  uuid PK DEFAULT gen_random_uuid()
user_id             uuid NOT NULL                  -- auth.uid() via RLS
name                text NOT NULL
base_url            text NOT NULL
description         text
context             jsonb                           -- structured {audience, workflow, quirks}
credentials         jsonb                           -- [{label, username, password}]
resources           jsonb                           -- [{type, label, value}] test resources for AI agent
discovered_context  jsonb DEFAULT '{}'              -- AI-enriched product knowledge
design              jsonb                           -- {logoUrl, accentColor, bgColor, textColor, font, widgetPosition, widgetGreeting}
widget_api_key      text UNIQUE                     -- embeddable widget key
widget_enabled      boolean NOT NULL DEFAULT false
mcp_api_key         text UNIQUE                     -- MCP server key (independent from widget)
mcp_enabled         boolean NOT NULL DEFAULT false
walkthrough_enabled boolean NOT NULL DEFAULT false  -- AI-guided walkthrough in widget
created_at          timestamptz DEFAULT now()
updated_at          timestamptz DEFAULT now()
```
**RLS**: `auth.uid() = user_id` for ALL operations
**Indexes**: `idx_projects_user_id`, `idx_projects_widget_api_key`, `idx_projects_mcp_api_key` (partial, where mcp_api_key is not null)

### doc_pages
```sql
id                uuid PK DEFAULT gen_random_uuid()
project_id        uuid NOT NULL FK → projects(id) CASCADE
parent_id         uuid FK → doc_pages(id) SET NULL
title             text NOT NULL
slug              text NOT NULL                   -- unique per project
start_url         text                            -- where the agent starts
goal              text                            -- what the page should document
content           text                            -- editable markdown (source of truth for display)
custom_prompt     text                            -- legacy user instructions
briefing          jsonb                           -- {objective, knowledge, resources[], selectedResources?, showVideoOnPublic?}
status            text NOT NULL DEFAULT 'draft'   -- draft | exploring | published
sort_order        integer NOT NULL DEFAULT 0
is_public         boolean NOT NULL DEFAULT false  -- per-page public sharing
created_at        timestamptz DEFAULT now()
updated_at        timestamptz DEFAULT now()
UNIQUE(project_id, slug)
```
**Indexes**: `idx_doc_pages_project_id`, `idx_doc_pages_parent_id`

### runs
```sql
id                     uuid PK DEFAULT gen_random_uuid()
feature_name           text NOT NULL                 -- "[Test] ..." prefix = Try Doc run
start_url              text NOT NULL
goal                   text NOT NULL
status                 text NOT NULL DEFAULT 'pending'   -- pending | running | blocked | completed | failed
token_usage            integer DEFAULT 0
browserbase_session_id text                          -- Browserbase session (for resume)
doc_page_id            uuid FK → doc_pages(id) SET NULL
project_id             uuid FK → projects(id) SET NULL  -- direct link for usage/analytics
summary_json           jsonb                         -- {sections, blockers, agentMessage, videoPath,
                                                     --  stepTimestamps[], voiceover{audioPath,audioUrl,segments[]},
                                                     --  trimApplied{startTime,endTime}, tryDocReport}
created_at             timestamptz DEFAULT now()
updated_at             timestamptz DEFAULT now()
```
**Indexes**: `idx_runs_doc_page_id`, `idx_runs_project_id`, composite `runs(doc_page_id, created_at DESC)`
**Note**: `summary_json.tryDocReport` stores the 7-section Try Doc analysis report produced by `POST /runs/:id/analyze-try`. `summary_json.voiceover` stores ElevenLabs narration output.

### run_steps
```sql
id               uuid PK DEFAULT gen_random_uuid()
run_id           uuid NOT NULL FK → runs(id) CASCADE
step_index       integer NOT NULL
url              text
title            text                             -- semantic description
action           text                             -- what the agent did
observation      text                             -- agent reasoning (~8000 char cap)
screenshot_path  text                             -- Supabase Storage path
status           text DEFAULT 'completed'         -- completed | blocked | skipped
created_at       timestamptz DEFAULT now()
```
**Index**: `idx_run_steps_run_id`

### run_questions
```sql
id            uuid PK DEFAULT gen_random_uuid()
run_id        uuid NOT NULL FK → runs(id) CASCADE
step_id       uuid FK → run_steps(id) SET NULL
question      text NOT NULL
answer        text
answered_at   timestamptz
created_at    timestamptz DEFAULT now()
```
**Index**: `idx_run_questions_run_id`

### generated_docs
```sql
id                uuid PK DEFAULT gen_random_uuid()
run_id            uuid NOT NULL UNIQUE FK → runs(id) CASCADE
doc_page_id       uuid FK → doc_pages(id) SET NULL
markdown_content  text                             -- AI-generated markdown (immutable per generation)
json_content      jsonb                            -- self-assessment, gaps, suggestions
created_at        timestamptz DEFAULT now()
updated_at        timestamptz DEFAULT now()
```
**Index**: `idx_generated_docs_doc_page_id`

### artifacts
```sql
id          uuid PK DEFAULT gen_random_uuid()
run_id      uuid NOT NULL FK → runs(id) CASCADE
type        text NOT NULL                         -- screenshot | trace | export
path        text NOT NULL                         -- Supabase Storage path
created_at  timestamptz DEFAULT now()
```
**Index**: `idx_artifacts_run_id`
**Storage**: The `artifacts` Supabase Storage bucket is public (see migration 20).

### doc_embeddings
```sql
id           uuid PK DEFAULT gen_random_uuid()
project_id   uuid NOT NULL FK → projects(id) CASCADE
page_id      uuid NOT NULL FK → doc_pages(id) CASCADE
chunk_index  integer NOT NULL
chunk_text   text NOT NULL
embedding    vector(768) NOT NULL                 -- pgvector, Gemini embedding model
page_title   text NOT NULL
page_slug    text NOT NULL
created_at   timestamptz DEFAULT now()
```
**Indexes**: `idx_doc_embeddings_project_id`, `idx_doc_embeddings_page_id`, `idx_doc_embeddings_vector` (HNSW, cosine)
**RLS**: via `project_id → projects.user_id`
**Function**: `match_doc_chunks(project_id, embedding, match_count, threshold)` — cosine similarity search

### jobs
```sql
id          uuid PK DEFAULT gen_random_uuid()
run_id      uuid NOT NULL FK → runs(id) CASCADE
page_id     uuid NOT NULL FK → doc_pages(id) CASCADE
project_id  uuid NOT NULL FK → projects(id) CASCADE
type        text NOT NULL                         -- 'doc-gen' | 'voiceover' | 'try-doc'
status      text NOT NULL DEFAULT 'running'       -- running | completed | failed
error       text
created_at  timestamptz DEFAULT now()
updated_at  timestamptz DEFAULT now()
```
**Indexes**: `idx_jobs_project_id`, `idx_jobs_run_id`, `idx_jobs_status` (partial, where status='running'),
unique partial `idx_jobs_page_type_running` (prevents duplicate running jobs per page+type).
**RLS**: users see jobs for their own projects.
**Trigger**: `trg_cleanup_old_jobs` deletes completed/failed jobs older than 24h on every insert.
**Realtime**: the `jobs` table is added to the `supabase_realtime` publication so the frontend (`useJobRealtime`) gets instant notifications.

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
| 16 | `20260408000001_add_widget_api_key.sql` | widget_api_key + widget_enabled on projects |
| 17 | `20260408000002_add_page_public.sql` | Add is_public to doc_pages |
| 18 | `20260409000001_add_project_design.sql` | Add design JSONB to projects |
| 19 | `20260413000000_add_walkthrough_enabled.sql` | Add walkthrough_enabled to projects |
| 20 | `20260413000001_make_artifacts_bucket_public.sql` | Make artifacts storage bucket public |
| 21 | `20260416000000_add_project_resources.sql` | Add resources JSONB to projects |
| 22 | `20260416000001_create_jobs_table.sql` | jobs table + Realtime publication for background-job tracking |
| 23 | `20260417000000_add_runs_project_id.sql` | Add project_id to runs (direct project-level queries) |
| 24 | `20260417000001_add_mcp_api_key.sql` | Add mcp_api_key + mcp_enabled to projects |

## Relationships

```
projects  1:N doc_pages         (CASCADE)
projects  1:N doc_embeddings    (CASCADE)
projects  1:N jobs              (CASCADE)
projects  1:N runs              (SET NULL on project delete, via project_id)
doc_pages 1:N doc_pages         (self-ref via parent_id, SET NULL)
doc_pages 1:N doc_embeddings    (CASCADE)
doc_pages 1:N runs              (via doc_page_id, SET NULL)
doc_pages 1:N jobs              (CASCADE)
runs      1:N run_steps         (CASCADE)
runs      1:N run_questions     (CASCADE)
runs      1:1 generated_docs    (CASCADE)
runs      1:N artifacts         (CASCADE)
runs      1:N jobs              (CASCADE)
```

## Row Level Security (RLS)

All tables have RLS enabled. Policies chain through project ownership:

| Table | Policy | Logic |
|---|---|---|
| `projects`        | Users see own projects        | `auth.uid() = user_id` |
| `doc_pages`       | Users access own project pages| `project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())` |
| `runs`            | Users access own runs         | via `doc_page_id → doc_pages → projects.user_id` |
| `run_steps`       | Users access own run steps    | via `run_id → runs → doc_pages → projects.user_id` |
| `run_questions`   | Users access own questions    | via `run_id → runs → doc_pages → projects.user_id` |
| `generated_docs`  | Users access own docs         | via `run_id → runs → doc_pages → projects.user_id` |
| `artifacts`       | Users access own artifacts    | via `run_id → runs → doc_pages → projects.user_id` |
| `doc_embeddings`  | Users access own embeddings   | via `project_id → projects.user_id` |
| `jobs`            | Users manage own jobs         | `project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())` |

**Note**: The backend uses the Supabase **service key**, which bypasses RLS. RLS protects direct client access (used by the Realtime subscription on `jobs`, and admin bypass paths). Page routes additionally verify ownership via `verifyProjectOwnership` middleware.

## Storage Buckets

| Bucket | Public | Contents |
|---|---|---|
| `artifacts`     | yes (migration 20) | screenshots, video, voice-over MP3s, logos |
| `briefing-files`| no                 | files uploaded as page briefing resources |

## Content Storage Strategy

- `generated_docs.markdown_content` = AI-generated output (immutable per generation).
- `doc_pages.content` = user's editable copy (source of truth for display).
- After AI generation → markdown auto-copied to `doc_pages.content`.
- User edits `doc_pages.content` freely; re-running video-to-doc overwrites it.
- Page content edits auto-re-index `doc_embeddings` (fire-and-forget in `page.service.ts`).
