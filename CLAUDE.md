# CLAUDE.md — AiDoc: AI Documentation Platform

> This file is the source of truth for all code generation in this project.
> Read it fully before writing any code. Never deviate from these rules.
> For detailed docs, see `/docs/ARCHITECTURE.md`, `/docs/WORKFLOWS.md`, `/docs/DATABASE.md`, `/docs/AI_PROMPTS.md`, `/docs/CONTRIBUTING.md`.

---

## Project Overview

AiDoc is a **project-based documentation platform** that generates user-facing product guides and deploys them as **embeddable AI chat widgets** on client apps. A **Try Doc** feature lets users test their documentation against the live product — an AI agent follows the doc steps as a naive user and generates a structured quality report.

**Screen recording** is the primary (and only) documentation generation method. Users record their screen (or upload a video) → Gemini analyzes every action → extracts screenshots at key moments → generates structured documentation → ElevenLabs generates voice-over narration.

**Try Doc**: An AI agent (Stagehand) follows the doc steps as a naive user on the live product and generates a structured quality report.

**Chat & Widget**: Users chat with their documentation (RAG-powered). The same chat can be embedded as a widget on client apps via a single `<script>` tag.

**Core flow**: Record screen or upload video → AI generates doc with screenshots + voice-over → User reviews/edits → Enable chat widget / MCP → Embed on client app (or attach to Claude / ChatGPT)

---

## Core Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript 5.9 (strict: true) |
| Backend | Express 5 (serverless on Vercel) |
| Browser Automation | Stagehand 3 (Browserbase cloud browsers) — Try Doc testing |
| AI (voice-over) | ElevenLabs TTS — multilingual voice-over narration for documentation |
| AI (primary) | Gemini 2.5 Flash — doc generation, context enrichment, chat, video analysis, narration, preflight, walkthrough, URL analysis, Try Doc analysis |
| AI (Try Doc) | Claude Sonnet 4 via Stagehand (`STAGEHAND_MODEL`) — Try Doc testing only |
| AI (embeddings) | Gemini embedding model (auto-discovered via ListModels API) — 768-dim vectors |
| Vector Search | pgvector in Supabase (HNSW index, cosine similarity) |
| Database | Supabase (Postgres + Auth + Storage + RLS + pgvector + Realtime on `jobs`) |
| Video | External FFmpeg microservice (`video-service/`, Dockerized, controlled by `VIDEO_SERVICE_URL`) |
| Extension | Chrome MV3 extension (`extension/`) for optional DOM capture during recording |
| MCP | JSON-RPC MCP server at `POST /api/mcp/:mcpApiKey` — exposes docs as tools to Claude / ChatGPT |
| Frontend | React 19 + Vite 8 + React Router 7 |
| Validation | Zod 4 |
| Testing | Vitest — doc-generation evals in `evals/` (no unit tests yet) |
| Linting | ESLint + Prettier |
| Deployment | Vercel (serverless function + static frontend) |

---

## Project Structure

```
src/
  features/
    project/              # User workspace CRUD (RLS isolated) + widget/MCP keys + URL analysis + usage
      project.types.ts
      project.schema.ts
      project.repository.ts
      project.service.ts
      project.routes.ts
    page/                 # Doc page hierarchy + preflight
      page.types.ts
      page.schema.ts
      page.repository.ts
      page.service.ts
      page.routes.ts
      public-docs.routes.ts  # Public GET /docs/:projectId (no auth)
    run/                  # Run lifecycle + video analysis + voiceover + Try Doc
      run.types.ts
      run.schema.ts
      run.repository.ts
      run.service.ts      # orchestrates exploration, video analysis, Try Doc
      run.routes.ts
      job.repository.ts   # background job tracking (jobs table)
    exploration/          # Stagehand agent + browser actions (Try Doc)
      exploration.types.ts
      exploration.service.ts  # agent instruction, onStepFinish callback
      exploration.browser.ts  # navigateTo, captureScreenshot
    documentation/        # Doc generation via Gemini + ElevenLabs voice-over
      documentation.types.ts  # GeneratedDoc, DocSelfAssessment, StructuralSuggestion, TryDocReport
      documentation.generator.ts  # calls Gemini 2.5 Flash, parses markdown + JSON
      documentation.service.ts    # orchestrates: fetch steps → resolve screenshots → generate
      documentation.repository.ts # findDocByRunId, findDocByPageId, upsertDoc
      voiceover.service.ts         # ElevenLabs TTS voice-over generation
      documentation.routes.ts
    chat/                 # RAG chat + widget + walkthrough + MCP server
      chat.types.ts           # ChatMessage, ChatResponse, DocChunk, UserContext
      chat.schema.ts          # Zod schemas for chat / walkthrough
      chat.repository.ts      # doc_embeddings CRUD + pgvector search
      chat.service.ts         # chunking, indexing, RAG pipeline, suggestions, walkthrough
      chat.routes.ts          # POST /chat, POST /index, GET /suggestions
      widget.routes.ts        # Public API: POST /widget/:key/chat, GET /config, POST /walkthrough
      mcp.routes.ts           # JSON-RPC MCP server at POST /mcp/:mcpApiKey
      walkthrough.types.ts    # DomSnapshot for AI-guided walkthrough
    questions/            # Blocker questions during exploration
      questions.types.ts
      questions.schema.ts
      questions.repository.ts
      questions.service.ts
      questions.routes.ts
  shared/
    ai/
      gemini.client.ts      # Gemini SDK: generateText(), embedTexts(), analyzeVideoWithGemini(),
                            # generateNarrationFromVideo(), correctTimestamps()
      anthropic.client.ts   # Anthropic SDK (optional, for Stagehand only)
      anthropic.types.ts
      elevenlabs.client.ts  # ElevenLabs TTS: synthesizeSpeech(), getAvailableVoices()
      prompt.builder.ts     # Doc-gen, context-enrichment, Try Doc, preflight, walkthrough prompts
    browser/
      playwright.client.ts  # launchBrowser(), closeBrowser(), getSessionId()
      browser.types.ts
    video/
      video.client.ts       # HTTP client for the FFmpeg microservice:
                            # convertToMp4, extractFrames, probeVideo, concatAudio, trimVideo
    db/
      supabase.client.ts
      storage.repository.ts # uploadToStorage(), getSignedUrl(), createSignedUploadUrl(), getPublicUrl()
    middleware/
      auth.middleware.ts     # Supabase JWT validation
      error.middleware.ts    # AppError, NotFoundError, ValidationError, DatabaseError
    config/
      env.ts                # Zod-validated env vars (crash on startup if missing)
    validation/
      schemas.ts            # UuidParamSchema (shared)
  ui/
    design-system/
      tokens.ts             # Color, spacing, font, shadow tokens
      globals.css           # CSS variables mapped to tokens
      components/           # Button, Badge, Card, StatusIndicator, CodeBlock,
                            # MarkdownRenderer, Field (Input.tsx), Spinner, EmptyState,
                            # BlockEditor, useImageLightbox, useConfirmDialog,
                            # TableOfContents, ProgressLoader
                            # Each: Component.tsx + Component.module.css
                            # Barrel export in index.ts (only allowed barrel)
    features/
      auth/pages/            # Login.tsx
      project/pages/         # ProjectList, NewProject, ProjectDetail, ProjectSettings, ProjectDesign
      page/
        pages/               # NewPage, PageView, SharePage
        components/           # PageTree, TryDocReport, PreflightPanel, ScreenRecorder,
                              # NarratedPlayer, VideoTimeline, SharePanel
      chat/
        components/           # ChatPanel
      docs/
        pages/               # PublicDocs (server-rendered style public docs viewer)
      run/
        components/           # RunCard, StepTimeline (run pages were removed with the
                              # project-first refactor — run UI lives inside PageView)
    shared/
      api/
        client.ts            # Typed API client with all DTOs and endpoints
        db.ts                # Direct Supabase helpers (embedding check bypass, job polling)
        supabase.ts          # Frontend Supabase client (VITE_ env vars)
      hooks/
        useAsync.ts          # Generic async data fetching hook
        useAuth.ts           # Supabase Auth state management
        useTheme.ts          # Light/dark theme hook
      jobs/
        JobContext.tsx       # Global job state provider
        JobTracker.tsx       # Floating progress UI
        useJobRealtime.ts    # Supabase Realtime subscription on `jobs` table
      layout/
        Shell.tsx             # App shell with topbar + fullWidth option
      theme/
        computeTheme.ts      # Derives CSS variables from project design
  app.ts                     # Express app (local dev)
  server.ts                  # Server startup
api/
  index.ts                   # Vercel serverless entry point
video-service/               # Dockerized FFmpeg microservice (separate deploy, Node + fluent-ffmpeg)
extension/                   # Chrome MV3 extension (dom-capture.js, bridge.js, background.js, manifest.json)
evals/                       # Vitest evals: fixtures + criteria + scorer + eval.test.ts
supabase/migrations/         # 24 SQL migrations (see docs/DATABASE.md)
docs/
  ARCHITECTURE.md            # Stack, data model, patterns, API routes
  WORKFLOWS.md               # All user flows step-by-step
  DATABASE.md                # Complete schema + migrations
  AI_PROMPTS.md              # Models, prompts, self-assessment schema
  CONTRIBUTING.md            # Rules, how-to guides, tech debt
```

---

## Hard Rules (never break these)

1. **No `any`** — ever. Use `unknown` + type guards.
2. **No Supabase calls outside `*.repository.ts` files.**
3. **Doc generation prompts in `prompt.builder.ts`** — the exploration instruction in `exploration.service.ts` is the only exception (it's dynamic).
4. **No `waitForTimeout`** — use `waitForLoadState('networkidle')`.
5. **No feature imports another feature's service directly** — use dependency injection interfaces (e.g. `RunDeps`, `DocDeps`).
6. **Always close the browser in a `finally` block** — avoid Browserbase billing.
7. **Always track token usage** per AI call and accumulate on the run.
8. **Zod validates all external input** — API requests, AI responses, env vars.
9. **One migration file per schema change** — never edit existing migrations.
10. **No business logic in routes** — routes validate input, call services, return responses.
11. **Update docs/** — when changing architecture, workflows, schema, or prompts.

---

## AI / Model Rules

### Gemini-first stack
- **Doc generation**: Gemini 2.5 Flash via `generateText()` in `gemini.client.ts`
- **Video analysis**: Gemini 2.5 Flash with Files API for native video understanding
- **Voice-over narration script**: Gemini 2.5 Flash watches the video and writes an ElevenLabs-v3-formatted script
- **Voice-over TTS**: ElevenLabs (`eleven_multilingual_v2`)
- **Context enrichment**: Gemini 2.5 Flash — fire-and-forget after doc gen (in `run.service.ts`)
- **Chat (RAG)**: Gemini 2.5 Flash with pgvector-retrieved context
- **Embeddings**: Auto-discovered Gemini embedding model, 768-dim output
- **Preflight**: Gemini 2.5 Flash — checks doc readiness before a Try Doc run
- **Walkthrough**: Gemini 2.5 Flash — maps docs to live DOM for the widget
- **URL analysis**: Gemini 2.5 Flash — auto-fills project name / context / design from a URL
- **Try Doc analysis**: Gemini 2.5 Flash — analyzes Stagehand test results into a 7-section JSON report
- **Stagehand (Try Doc)**: `STAGEHAND_MODEL` constant (`anthropic/claude-sonnet-4-20250514`) — requires `ANTHROPIC_API_KEY`
- **MCP**: Gemini embeddings + pgvector search exposed as MCP tools (`search_documentation`, `list_pages`)

### Prompt rules
- All doc generation prompts live in `shared/ai/prompt.builder.ts`
- Exploration instruction is built inline in `exploration.service.ts` (dynamic context)
- Always parse AI JSON responses with Zod — never trust raw output
- Self-assessment JSON must include `overallCompleteness`, `gaps`, `nextSteps`, `structuralSuggestions`

### Cross-page awareness
When exploring or generating docs, the AI receives:
- **Project context** — structured: audience, workflow, quirks (stored as JSONB in `projects.context`)
- **Table of contents** — all sibling pages with status
- **Page content summaries** — first 200 chars of each sibling's content
- **Credentials** — test login credentials as Stagehand variables
- **Page briefing** — structured per-page context: objective, domain knowledge, typed resources (stored as JSONB in `doc_pages.briefing`)

These are assembled in `run.service.ts` → `getProjectAwareness()` and passed through to exploration and doc generation.

---

## Database Rules

### Naming
- Tables: `snake_case`, plural (`projects`, `doc_pages`, `runs`)
- Columns: `snake_case`
- All tables have: `id uuid DEFAULT gen_random_uuid()`, `created_at`, `updated_at`

### Repository pattern
Every DB call through `*.repository.ts`. Services NEVER call Supabase directly.

### Content storage
- `generated_docs.markdown_content` = AI output (immutable per generation)
- `doc_pages.content` = user's editable copy (source of truth for display)
- After generation → auto-copied to `doc_pages.content`

### Full schema reference
See `docs/DATABASE.md` — 9 tables (`projects`, `doc_pages`, `runs`, `run_steps`, `run_questions`, `generated_docs`, `artifacts`, `doc_embeddings`, `jobs`), 24 migrations.

---

## API Design

### Route structure
```
# Projects (auth)
/api/projects                              # GET list / POST create
/api/projects/analyze-url                  # POST: auto-fill project from URL
/api/projects/:id                          # GET / PUT / DELETE
/api/projects/:id/widget-key               # POST: generate key, DELETE: disable widget
/api/projects/:id/mcp-key                  # POST: generate MCP key, DELETE: disable MCP
/api/projects/:id/logo                     # POST: upload project logo (raw body)
/api/projects/:id/usage                    # GET: token usage + cost estimate

# Pages (auth, nested under :projectId, ownership verified)
/api/projects/:pid/pages                   # GET tree / POST create
/api/projects/:pid/pages/reorder           # PUT: bulk reorder + re-parent
/api/projects/:pid/pages/:id               # GET / PUT / DELETE
/api/projects/:pid/pages/:id/full          # GET: page + latest run + doc in one call
/api/projects/:pid/pages/:id/doc           # GET: page documentation
/api/projects/:pid/pages/:id/run           # GET: latest run for page
/api/projects/:pid/pages/:id/test-report   # GET: latest Try Doc report
/api/projects/:pid/pages/:id/preflight     # POST: Gemini preflight before Try Doc

# Chat (authenticated)
/api/projects/:pid/chat                    # POST: RAG chat
/api/projects/:pid/chat/index              # POST: index / re-index embeddings
/api/projects/:pid/chat/suggestions        # GET: dynamic suggestions (cached 1h)

# Runs (auth)
/api/runs                                  # GET list / POST create
/api/runs/voices                           # GET: ElevenLabs voices
/api/runs/:id                              # GET
/api/runs/:id/explore                      # POST: SSE stream (Try Doc exploration)
/api/runs/:id/cancel                       # POST: cancel running exploration
/api/runs/:id/signed-upload-url            # POST: signed PUT URL for direct upload
/api/runs/:id/steps/:idx/screenshot        # POST: update step screenshot path
/api/runs/:id/analyze-video                # POST: Gemini video analysis (+ optional doc pipeline)
/api/runs/:id/generate-doc                 # POST (?async=1 → 202 + background job)
/api/runs/:id/generate-voiceover           # POST: Gemini script + ElevenLabs TTS
/api/runs/:id/regenerate-segment           # POST: re-synthesize single segment
/api/runs/:id/voiceover-segments           # PUT: adjust segment timing
/api/runs/:id/trim-video                   # POST: trim video to time range
/api/runs/:id/analyze-try                  # POST: Gemini Try Doc analysis
/api/runs/:id/steps                        # GET
/api/runs/:id/questions                    # GET
/api/runs/:id/doc                          # GET
/api/runs/:id/questions/:qid/answer        # POST

# Public (no auth)
/api/health                                # GET: health check
/api/docs/:projectId                       # GET: public pages (is_public=true)
/api/widget/:key/chat                      # POST: public chat (API key, 30/min)
/api/widget/:key/config                    # GET: widget config (edge-cached)
/api/widget/:key/walkthrough               # POST: AI-guided walkthrough (10/min)
/api/mcp/:mcpApiKey                        # POST: JSON-RPC MCP server (30/min)
```

### Error format
```ts
interface ApiError {
  error: string      // human-readable
  code: string       // machine-readable: RUN_NOT_FOUND, VALIDATION_ERROR
  details?: unknown
}
```

HTTP status codes: 200, 201, 400, 401, 404, 422, 500.

---

## Design System

**Aesthetic**: Industrial/utilitarian — dark background, monospaced accents, sharp edges, status-driven colors. Think Linear meets Raycast.

### Component rules
- CSS Modules for all components (`.module.css`)
- CSS variables from `globals.css` map to tokens — never hardcode colors
- Status always uses the status color tokens
- `MarkdownRenderer` for rich doc display (react-markdown)
- `CodeBlock` for raw code display
- `BlockEditor` — BlockNote (TipTap/ProseMirror) markdown editor with auto-save
- `ConfirmDialog` (via `useConfirmDialog` hook) — portal-based confirm with danger/primary variants
- `ProgressLoader` — multi-step progress with animated indicators
- `TableOfContents` — floating side indicator, expands on hover to show headings
- `ImageLightbox` (via `useImageLightbox` hook) — click any doc image to fullscreen

### Frontend patterns
- Feature-first organization mirrors backend
- `useAsync` hook for data fetching
- `useAuth` hook for Supabase Auth
- `useTheme` hook for light/dark mode
- `Shell` layout with `fullWidth` option for project sidebar
- SSE streaming via fetch + ReadableStream for live exploration
- Supabase Realtime subscription on `jobs` (via `useJobRealtime`) powers the floating `JobTracker`
- `computeTheme` derives CSS variables at runtime from the project's `design` JSONB

---

## Environment Variables

**Backend** (validated at startup via Zod in `src/shared/config/env.ts`):
```
# Required
NODE_ENV, PORT, SUPABASE_URL, SUPABASE_SERVICE_KEY,
GEMINI_API_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID

# Optional
ANTHROPIC_API_KEY    # Required only for Try Doc testing (Stagehand with Claude Sonnet 4)
ELEVENLABS_API_KEY   # Required only for voice-over narration
VIDEO_SERVICE_URL    # URL of the FFmpeg microservice (video-service/). Features degrade
                     # gracefully when unset: no MP4 conversion / frame extraction / trim / concat.
```

**Frontend** (Vite prefix):
```
VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
```

---

## Deployment

- **Platform**: Vercel
- **Backend**: `api/index.ts` serverless function (`maxDuration: 300s`)
- **Frontend**: Vite build → `dist/client/`
- **Rewrites**: `/api/*` → serverless, `/*` → SPA fallback
- **Video service**: Deployed separately from `video-service/Dockerfile`
- Auth: Supabase JWT with RLS on all tables

---

## Known Tech Debt

- [ ] Exploration instruction built inline in `exploration.service.ts` (should move to `prompt.builder.ts`)
- [ ] Narration and URL-analysis prompts are inline in route files (should move to `prompt.builder.ts`)
- [x] ~~Stagehand model hardcoded in 2 places~~ — now uses `STAGEHAND_MODEL` constant
- [x] ~~No rate limiting~~ — widget chat 30/min, widget walkthrough 10/min, MCP 30/min
- [ ] `run.service.ts` imports `questions.repository` directly (cross-feature)
- [ ] `run.service.ts` touches Supabase Storage directly (`briefing-files` download)
- [ ] `project.routes.ts` queries Supabase directly in `/usage` (should live in the repository)
- [ ] No unit tests (Vitest configured, only doc-gen evals in `evals/` are in use)
- [ ] No pagination on list endpoints
- [ ] Widget / MCP API keys are public — no domain / origin restriction
- [x] ~~Chat suggestions cache is in-memory~~ — widget endpoint has in-memory cache + edge caching
- [ ] No usage analytics / logging for widget chat messages
- [ ] Try Doc report could inline screenshots for failed steps
- [x] ~~Widget config slow~~ — edge caching + inline `data-cfg` attribute

---

*Last updated: 2026-04-17*
*Stack: Node 20 / TS 5.9 / Gemini 2.5 Flash / Stagehand 3 (beta) / Supabase JS 2.x + pgvector + Realtime / Vite 8 / React 19*
