# Architecture

## Overview

AiDoc is a project-based documentation platform. Users record their screen (or upload a video), and Gemini analyzes it into a structured product guide with screenshots and voice-over narration. The result can be chatted with via RAG, embedded as a widget on a client app, or exposed to AI assistants (Claude, ChatGPT) through a built-in MCP server. A "Try Doc" feature runs a naive-user Stagehand agent against the live product and produces a structured test report.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript 5.9 (strict) |
| Backend | Express 5 (serverless on Vercel) |
| Browser (Try Doc) | Stagehand 3 (Browserbase cloud) |
| AI (Try Doc agent) | Claude Sonnet 4 via Stagehand `STAGEHAND_MODEL` |
| AI (primary) | Gemini 2.5 Flash — doc generation, chat, video analysis, narration, preflight, walkthrough, enrichment |
| AI (voice-over) | ElevenLabs TTS (`eleven_multilingual_v2`) |
| AI (embeddings) | Gemini embedding model (auto-discovered, 768-dim) |
| Database | Supabase (Postgres + Auth + Storage + RLS + pgvector) |
| Video | Separate FFmpeg microservice (`video-service/`) |
| Extension | Chrome extension (`extension/`) for optional DOM capture |
| Frontend | React 19 + Vite 8 + React Router 7 |
| Validation | Zod 4 |
| Testing | Vitest (evals + a few unit tests in `evals/`) |
| Deployment | Vercel (serverless + static) |

## Data Model

```
User (Supabase Auth)
  └─ Project (name, baseUrl, context{audience,workflow,quirks}, credentials[], resources[],
              design{logoUrl,accentColor,...}, widgetApiKey, mcpApiKey, walkthroughEnabled)
       └─ DocPage (title, slug, parentId, sortOrder, content, briefing{objective,knowledge,resources[]},
                   status, isPublic, customPrompt)
            │    └─ DocEmbedding (chunk_text, embedding vec(768))   [for RAG]
            └─ Run (featureName, startUrl, goal, status, tokenUsage, summary_json{tryDocReport, voiceover, videoPath, stepTimestamps}, projectId)
                 ├─ RunStep (action, observation, screenshotPath, status)
                 ├─ RunQuestion (question, answer)
                 └─ GeneratedDoc (markdownContent, jsonContent)
  └─ Job (runId, pageId, projectId, type, status, error)   [background work tracking]
```

## Feature Directory Structure

```
src/features/
  project/          # User workspace CRUD, widget/MCP keys, URL analysis, usage reporting
  page/             # Doc page hierarchy + preflight + public docs router
                    #   public-docs.routes.ts — public GET /docs/:projectId (no auth)
  run/              # Run lifecycle, video analysis, voiceover, Try Doc
                    #   job.repository.ts — background job tracking (jobs table)
  exploration/      # Stagehand agent + browser actions (for Try Doc)
  documentation/    # Doc generation (Gemini) + voice-over (ElevenLabs)
  questions/        # Blocker questions during exploration
  chat/             # RAG chat + widget + walkthrough + MCP server
                    #   chat.routes.ts   — authenticated chat
                    #   widget.routes.ts — public widget (API key)
                    #   mcp.routes.ts    — JSON-RPC MCP server (separate API key)

src/shared/
  ai/               # Gemini client (text/embed/video/narration), ElevenLabs client,
                    # Anthropic types, prompt.builder.ts (all doc-gen/analysis prompts)
  browser/          # Stagehand / Playwright client
  video/            # HTTP client for the FFmpeg microservice
                    # (convert, probe, extract-frames, concat-audio, trim)
  db/               # Supabase client + storage repository (signed URLs, upload, public URL)
  config/           # Zod-validated env vars (fails fast)
  middleware/       # Supabase JWT auth, AppError/NotFoundError/ValidationError/DatabaseError
  validation/       # Shared Zod schemas (UuidParamSchema)

src/ui/
  design-system/    # Tokens, globals.css, components (Button, Badge, Card, StatusIndicator,
                    # CodeBlock, MarkdownRenderer, Field (Input.tsx), Spinner, EmptyState,
                    # BlockEditor, useImageLightbox, useConfirmDialog, TableOfContents,
                    # ProgressLoader). Barrel export in index.ts (only allowed barrel).
  features/         # Feature pages + components (auth, project, page, chat, docs, run)
  shared/
    api/            # Typed client (client.ts), db.ts (Supabase direct helpers), supabase.ts
    hooks/          # useAsync, useAuth, useTheme
    jobs/           # JobContext + JobTracker + useJobRealtime (Supabase Realtime on jobs table)
    layout/         # Shell + Shell.module.css
    theme/          # computeTheme (derives CSS variables from project design)

api/index.ts        # Vercel serverless entry
video-service/      # Dockerized FFmpeg microservice (separate deploy, see video-service/Dockerfile)
extension/          # Chrome MV3 extension: dom-capture.js, bridge.js, background.js
evals/              # Vitest evals: fixtures + criteria + scorer + eval.test.ts
supabase/migrations # 24 SQL migrations (see docs/DATABASE.md)
```

## File Naming Convention

Each backend feature follows:
```
feature/
  feature.types.ts       # All TypeScript interfaces
  feature.schema.ts      # Zod validation schemas
  feature.repository.ts  # All DB calls (Supabase queries)
  feature.service.ts     # Business logic (calls repos, not other services)
  feature.routes.ts      # Express routes (calls services, no logic)
```

## Key Patterns

### Repository Pattern
All database calls go through `*.repository.ts`. Services never call Supabase directly.
Known exception: `run.service.ts` performs an inline `supabase.storage.from('briefing-files').download(...)` when enriching page briefings, and `project.routes.ts` performs an inline `supabase.from('runs').select(...)` in the `/usage` endpoint — both tracked as tech debt.

### Dependency Injection
Services receive `deps` interfaces rather than importing other feature services directly.
```typescript
interface RunDeps {
  findRunById: (id: string) => Promise<Run | null>
  updateRunStatus: (id: string, status: RunStatus) => Promise<unknown>
  incrementTokenUsage: (id: string, tokens: number) => Promise<unknown>
  setBrowserbaseSessionId: (id: string, sessionId: string) => Promise<unknown>
  createRunStep: (step: ...) => Promise<unknown>
  countSteps: (id: string) => Promise<number>
  findStepsByRunId: (id: string) => Promise<RunStep[]>
}
```
Known exception: `run.service.ts` imports `questions.repository` directly — tracked as tech debt.

### Prompt Centralization
All doc-gen/analysis prompts live in `shared/ai/prompt.builder.ts`:
`buildContextEnrichmentPrompt`, `buildDocumentationPrompt`, `buildTryDocAnalysisPrompt`,
`buildPreflightAnalysisPrompt`, `buildWalkthroughPrompt`, plus system constants
(`VIDEO_DOC_SYSTEM_PROMPT`, `TRY_DOC_ANALYSIS_SYSTEM_PROMPT`, `PREFLIGHT_SYSTEM_PROMPT`,
`WALKTHROUGH_SYSTEM_PROMPT`). Exception: the Stagehand exploration instruction is built inline
in `exploration.service.ts` because it's highly dynamic (known tech debt).

### Jobs & Realtime
Long-running operations (doc-gen, voice-over, try-doc) insert a row into the `jobs` table.
The frontend subscribes to Supabase Realtime on `jobs` (`useJobRealtime`) so the `JobTracker`
UI survives browser refresh and cross-tab navigation. A DB trigger cleans up completed/failed
jobs older than 24 hours.

### Video Microservice
`src/shared/video/video.client.ts` wraps an external Node/FFmpeg service (`video-service/`,
Dockerized, separate deploy). Operations: `convertToMp4`, `extractFrames`, `probeVideo`,
`concatAudio`, `trimVideo`. Controlled by `VIDEO_SERVICE_URL`. Falls back gracefully when
not configured.

### MCP Server
A JSON-RPC MCP endpoint at `POST /api/mcp/:mcpApiKey` exposes two tools (`search_documentation`
and `list_pages`) so external AI assistants can query a project's docs with a single URL.
Separate from the widget API key. Rate-limited (30 req/min).

### Smart RAG
Greetings / small-talk skip embedding search via `needsDocSearch` heuristic in `chat.service.ts`.

### Error Handling
```typescript
AppError → { error: string, code: string, details?: unknown }
├─ NotFoundError (404)
├─ ValidationError (422)
└─ DatabaseError (500)
```

## API Route Structure

```
# Public (no auth)
GET    /api/health
GET    /api/docs/:projectId                    # public project page listing
POST   /api/widget/:key/chat                   # widget API key, rate-limited 30/min
GET    /api/widget/:key/config                 # edge-cached widget config
POST   /api/widget/:key/walkthrough            # widget API key, rate-limited 10/min
POST   /api/mcp/:mcpApiKey                     # JSON-RPC MCP server, rate-limited 30/min

# Projects (auth)
GET    /api/projects
POST   /api/projects
POST   /api/projects/analyze-url               # auto-fill project details + design from URL
GET    /api/projects/:id
PUT    /api/projects/:id
DELETE /api/projects/:id
POST   /api/projects/:id/widget-key            # generate / enable widget API key
DELETE /api/projects/:id/widget-key            # disable widget
POST   /api/projects/:id/mcp-key               # generate / enable MCP API key
DELETE /api/projects/:id/mcp-key               # disable MCP
POST   /api/projects/:id/logo                  # upload logo (raw body)
GET    /api/projects/:id/usage                 # token usage + cost estimate

# Pages (auth, nested under :projectId, ownership verified)
GET    /api/projects/:pid/pages                # tree
POST   /api/projects/:pid/pages
PUT    /api/projects/:pid/pages/reorder        # bulk reorder + re-parent
GET    /api/projects/:pid/pages/:id
GET    /api/projects/:pid/pages/:id/full       # page + latest run + doc in one call
PUT    /api/projects/:pid/pages/:id
DELETE /api/projects/:pid/pages/:id
GET    /api/projects/:pid/pages/:id/doc
GET    /api/projects/:pid/pages/:id/run
GET    /api/projects/:pid/pages/:id/test-report
POST   /api/projects/:pid/pages/:id/preflight  # Gemini preflight before Try Doc

# Chat (auth)
POST   /api/projects/:pid/chat
POST   /api/projects/:pid/chat/index
GET    /api/projects/:pid/chat/suggestions

# Runs (auth)
GET    /api/runs
POST   /api/runs
GET    /api/runs/:id
GET    /api/runs/voices                        # list available ElevenLabs voices
POST   /api/runs/:id/explore                   # SSE stream (Try Doc exploration)
POST   /api/runs/:id/cancel
POST   /api/runs/:id/signed-upload-url         # signed PUT URL for direct upload
POST   /api/runs/:id/steps/:stepIndex/screenshot
POST   /api/runs/:id/analyze-video             # Gemini video analysis (+ optional doc pipeline via generateDoc flag)
POST   /api/runs/:id/generate-doc              # ?async=1 → returns 202 and generates in background
POST   /api/runs/:id/generate-voiceover
POST   /api/runs/:id/regenerate-segment
PUT    /api/runs/:id/voiceover-segments
POST   /api/runs/:id/trim-video
POST   /api/runs/:id/analyze-try               # Gemini Try Doc report
GET    /api/runs/:id/steps
GET    /api/runs/:id/questions
GET    /api/runs/:id/doc
POST   /api/runs/:id/questions/:qid/answer
```

## Deployment

- **Vercel**: `api/index.ts` → serverless function (`maxDuration: 300s`), `dist/client/` → static SPA.
- **Rewrites**: `/api/*` → function, `/*` → SPA fallback.
- **Video service**: Deployed separately (see `video-service/Dockerfile`), accessed via `VIDEO_SERVICE_URL` env.
- **Auth**: Supabase JWT + RLS on all tables. Backend uses the Supabase service key, which bypasses RLS; route-level ownership checks (e.g. `verifyProjectOwnership` in `page.routes.ts`) guard cross-tenant access.
