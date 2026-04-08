# CLAUDE.md — AiDoc: AI Documentation Platform

> This file is the source of truth for all code generation in this project.
> Read it fully before writing any code. Never deviate from these rules.
> For detailed docs, see `/docs/ARCHITECTURE.md`, `/docs/WORKFLOWS.md`, `/docs/DATABASE.md`, `/docs/AI_PROMPTS.md`, `/docs/CONTRIBUTING.md`.

---

## Project Overview

AiDoc is a **project-based documentation platform** that generates user-facing product guides and deploys them as **embeddable AI chat widgets** on client apps.

**Two generation methods**:
1. **Screen recording (recommended)** — User uploads a video → Gemini analyzes every action → extracts screenshots at key moments → Gemini generates structured documentation
2. **Auto-exploration (beta)** — AI agent navigates the app autonomously via cloud browser → captures screenshots → generates docs

**Chat & Widget**: Users chat with their documentation (RAG-powered). The same chat can be embedded as a widget on client apps via a single `<script>` tag.

**Core flow**: Upload video or auto-explore → AI generates doc with screenshots → User reviews/edits → Enable chat widget → Embed on client app

---

## Core Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript 5.9 (strict: true) |
| Backend | Express 5 (serverless on Vercel) |
| Browser Automation | Stagehand 3 (Browserbase cloud browsers) — beta exploration only |
| AI (primary) | Gemini 2.5 Flash — doc generation, structure gen, context enrichment, chat, video analysis |
| AI (exploration) | Claude Sonnet 4 via Stagehand (`STAGEHAND_MODEL`) — beta only |
| AI (embeddings) | Gemini embedding model (auto-discovered via ListModels API) — 768-dim vectors |
| Vector Search | pgvector in Supabase (HNSW index, cosine similarity) |
| Database | Supabase (Postgres + Auth + Storage + RLS + pgvector) |
| Frontend | React 19 + Vite 8 + React Router 7 |
| Validation | Zod 4 |
| Testing | Vitest (configured, not yet used) |
| Linting | ESLint + Prettier |
| Deployment | Vercel (serverless function + static frontend) |

---

## Project Structure

```
src/
  features/
    project/              # User workspace CRUD (RLS isolated)
      project.types.ts
      project.schema.ts
      project.repository.ts
      project.service.ts
      project.routes.ts
    page/                 # Doc page hierarchy + auto-generate
      page.types.ts
      page.schema.ts
      page.repository.ts
      page.service.ts     # includes autoGenerateStructure()
      page.routes.ts
    run/                  # Exploration run lifecycle
      run.types.ts
      run.schema.ts
      run.repository.ts
      run.service.ts      # orchestrates exploration + doc gen
      run.routes.ts
    exploration/          # Stagehand agent + browser actions
      exploration.types.ts
      exploration.service.ts  # agent instruction, onStepFinish callback
      exploration.browser.ts  # navigateTo, captureScreenshot
    documentation/        # Doc generation via Gemini
      documentation.types.ts  # GeneratedDoc, DocSelfAssessment, StructuralSuggestion
      documentation.generator.ts  # calls Gemini 2.5 Flash, parses markdown + JSON
      documentation.service.ts    # orchestrates: fetch steps → resolve screenshots → generate
      documentation.repository.ts # findDocByRunId, findDocByPageId, upsertDoc
      documentation.routes.ts
    chat/                 # RAG chat + embeddable widget
      chat.types.ts           # ChatMessage, ChatResponse, DocChunk, UserContext
      chat.schema.ts          # Zod schemas for chat request + user context
      chat.repository.ts      # doc_embeddings CRUD + pgvector search
      chat.service.ts         # chunking, indexing, RAG pipeline, suggestions
      chat.routes.ts          # POST /chat, POST /index, GET /suggestions
      widget.routes.ts        # Public API: POST /widget/:key/chat, GET /config
    questions/            # Blocker questions during exploration
      questions.types.ts
      questions.schema.ts
      questions.repository.ts
      questions.service.ts
      questions.routes.ts
  shared/
    ai/
      gemini.client.ts      # Gemini SDK: generateText(), embedTexts(), analyzeVideoWithGemini()
      anthropic.client.ts   # Anthropic SDK (optional, for Stagehand only)
      anthropic.types.ts
      prompt.builder.ts     # buildDocumentationPrompt() — ALL doc gen prompts
    browser/
      playwright.client.ts  # launchBrowser(), closeBrowser(), getSessionId()
      browser.types.ts
    db/
      supabase.client.ts
      storage.repository.ts # uploadToStorage(), getSignedUrl(), createSignedUploadUrl()
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
      globals.css            # CSS variables mapped to tokens
      components/            # Button, Badge, Card, StatusIndicator, CodeBlock,
                             # MarkdownRenderer, Field, Spinner, EmptyState
                             # Each: Component.tsx + Component.module.css
                             # Barrel export in index.ts (only allowed barrel)
    features/
      auth/pages/            # Login.tsx
      project/pages/         # ProjectList, NewProject, ProjectDetail, ProjectSettings
      page/
        pages/               # NewPage, PageView (with edit mode + live exploration + video upload)
        components/           # PageTree (sidebar tree with move/reorder/delete)
      chat/
        components/           # ChatPanel (slide-out RAG chat with dynamic suggestions)
      run/
        pages/               # RunDashboard, RunDetail (legacy, pre-project model)
        components/           # RunCard, StepTimeline
    shared/
      api/
        client.ts            # Typed API client with all DTOs and endpoints
        supabase.ts          # Frontend Supabase client (VITE_ env vars)
      hooks/
        useAsync.ts          # Generic async data fetching hook
        useAuth.ts           # Supabase Auth state management
      layout/
        Shell.tsx             # App shell with topbar + fullWidth option
  app.ts                     # Express app (local dev)
  server.ts                  # Server startup
api/
  index.ts                   # Vercel serverless entry point
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
- **Structure auto-gen**: Gemini 2.5 Flash (proposes 5-15 doc pages from site content)
- **Context enrichment**: Gemini 2.5 Flash — fire-and-forget (in `run.service.ts`)
- **Chat (RAG)**: Gemini 2.5 Flash with pgvector-retrieved context
- **Embeddings**: Auto-discovered Gemini embedding model, 768-dim output
- **Stagehand (beta exploration)**: `STAGEHAND_MODEL` constant (`anthropic/claude-sonnet-4-20250514`) — requires `ANTHROPIC_API_KEY`

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
See `docs/DATABASE.md` — 8 tables (including `doc_embeddings` for RAG), 15 migrations.

---

## API Design

### Route structure
```
# Projects
/api/projects                              # Project CRUD
/api/projects/:pid/pages                   # Page hierarchy + auto-generate
/api/projects/:pid/pages/:id/doc           # Page documentation
/api/projects/:pid/pages/:id/run           # Latest run for page
/api/projects/:pid/widget-key              # POST: generate key, DELETE: disable widget

# Runs
/api/runs                                  # Run CRUD
/api/runs/:id/explore                      # POST: SSE stream (live exploration)
/api/runs/:id/analyze-video                # POST: Gemini video analysis
/api/runs/:id/generate-doc                 # POST: Doc generation
/api/runs/:id/signed-upload-url            # POST: Get signed URL for direct upload
/api/runs/:id/steps/:idx/screenshot        # POST: Update step screenshot path
/api/runs/:id/steps                        # Run steps
/api/runs/:id/questions                    # Blocker questions

# Chat (authenticated)
/api/projects/:pid/chat                    # POST: RAG chat with documentation
/api/projects/:pid/chat/index              # POST: Index/re-index doc embeddings
/api/projects/:pid/chat/suggestions        # GET: Dynamic suggestions (cached 1h)

# Widget (public — API key auth, no JWT)
/api/widget/:key/chat                      # POST: Public chat (rate limited 30/min)
/api/widget/:key/config                    # GET: Widget config + suggestions
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

### Frontend patterns
- Feature-first organization mirrors backend
- `useAsync` hook for data fetching
- `useAuth` hook for Supabase Auth
- `Shell` layout with `fullWidth` option for project sidebar
- SSE streaming via fetch + ReadableStream for live exploration

---

## Environment Variables

**Backend** (validated at startup via Zod):
```
# Required
NODE_ENV, PORT, SUPABASE_URL, SUPABASE_SERVICE_KEY,
GEMINI_API_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID

# Optional
ANTHROPIC_API_KEY    # Only needed for beta auto-exploration (Stagehand)
```

**Frontend** (Vite prefix):
```
VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
```

---

## Deployment

- **Platform**: Vercel
- **Backend**: `api/index.ts` serverless function (maxDuration: 300s)
- **Frontend**: Vite build → `dist/client/`
- **Rewrites**: `/api/*` → serverless, `/*` → SPA fallback
- Auth: Supabase JWT with RLS on `projects` table

---

## Known Tech Debt

- [ ] Exploration instruction built inline (should move to prompt.builder.ts)
- [x] ~~Stagehand model hardcoded in 2 places~~ — now uses `STAGEHAND_MODEL` constant
- [x] ~~No rate limiting~~ — widget endpoint has 30 req/min per API key
- [ ] `run.service.ts` imports `questions.repository` directly (cross-feature)
- [ ] No tests (Vitest configured but unused)
- [ ] No pagination on list endpoints
- [ ] Legacy RunDashboard/NewRun pages still exist (pre-project model)
- [ ] Widget: no domain restriction (Origin header check) — API key is public
- [ ] Chat suggestions cache is in-memory (lost on redeploy) — should be in DB
- [ ] No usage analytics/logging for widget chat messages

---

*Last updated: 2026-04-08*
*Stack: Node 20 / TS 5.9 / Gemini 2.5 Flash / Stagehand 3 (beta) / Supabase JS 2.x + pgvector / Vite 8 / React 19*
