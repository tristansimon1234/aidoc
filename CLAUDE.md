# CLAUDE.md — AiDoc: AI Documentation Platform

> This file is the source of truth for all code generation in this project.
> Read it fully before writing any code. Never deviate from these rules.
> For detailed docs, see `/docs/ARCHITECTURE.md`, `/docs/WORKFLOWS.md`, `/docs/DATABASE.md`, `/docs/AI_PROMPTS.md`, `/docs/CONTRIBUTING.md`.

---

## Project Overview

AiDoc is a **project-based documentation platform** that automatically explores web applications and generates user-facing product guides.

**Core flow**: User creates a project → AI scans the site and proposes doc structure → AI agent explores each page via a cloud browser → Claude generates structured documentation with screenshots → User reviews, edits, and organizes.

This is NOT a chatbot. It is an autonomous agent with a project-based lifecycle.

---

## Core Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript 5.9 (strict: true) |
| Backend | Express 5 (serverless on Vercel) |
| Browser Automation | Stagehand 3 (Browserbase cloud browsers) |
| AI (exploration) | Claude Haiku 4.5 (`anthropic/claude-haiku-4-5-20251001`) |
| AI (doc generation) | Claude Sonnet 4 (`claude-sonnet-4-20250514` via `CLAUDE_MODEL`) |
| Database | Supabase (Postgres + Auth + Storage + RLS) |
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
    documentation/        # Doc generation via Claude
      documentation.types.ts  # GeneratedDoc, DocSelfAssessment, StructuralSuggestion
      documentation.generator.ts  # calls Claude Sonnet, parses markdown + JSON
      documentation.service.ts    # orchestrates: fetch steps → resolve screenshots → generate
      documentation.repository.ts # findDocByRunId, findDocByPageId, upsertDoc
      documentation.routes.ts
    questions/            # Blocker questions during exploration
      questions.types.ts
      questions.schema.ts
      questions.repository.ts
      questions.service.ts
      questions.routes.ts
  shared/
    ai/
      anthropic.client.ts   # Anthropic SDK + CLAUDE_MODEL constant
      anthropic.types.ts
      prompt.builder.ts     # buildDocumentationPrompt() — ALL doc gen prompts
    browser/
      playwright.client.ts  # launchBrowser(), closeBrowser(), getSessionId()
      browser.types.ts
    db/
      supabase.client.ts
      storage.repository.ts # uploadToStorage(), getSignedUrl()
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
        pages/               # NewPage, PageView (with edit mode + live exploration)
        components/           # PageTree (sidebar tree with move/reorder/delete)
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
7. **Always track token usage** per Anthropic call and accumulate on the run.
8. **Zod validates all external input** — API requests, AI responses, env vars.
9. **One migration file per schema change** — never edit existing migrations.
10. **No business logic in routes** — routes validate input, call services, return responses.
11. **Update docs/** — when changing architecture, workflows, schema, or prompts.

---

## AI / Model Rules

### Two models, two purposes
- **Stagehand (exploration)**: `anthropic/claude-haiku-4-5-20251001` — cheap, good enough for navigation
- **Doc generation**: `CLAUDE_MODEL` constant (`claude-sonnet-4-20250514`) — quality matters here

### Prompt rules
- All doc generation prompts live in `shared/ai/prompt.builder.ts`
- Exploration instruction is built inline in `exploration.service.ts` (dynamic context)
- Always parse AI JSON responses with Zod — never trust raw output
- Self-assessment JSON must include `overallCompleteness`, `gaps`, `nextSteps`, `structuralSuggestions`

### Cross-page awareness
When exploring or generating docs, the AI receives:
- **Project context** — product description, terminology
- **Table of contents** — all sibling pages with status
- **Page content summaries** — first 200 chars of each sibling's content
- **Credentials** — test login credentials as Stagehand variables
- **Custom prompt** — user's page-specific instructions

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
See `docs/DATABASE.md` — 7 tables, 8 migrations.

---

## API Design

### Route structure
```
/api/projects                              # Project CRUD
/api/projects/:pid/pages                   # Page hierarchy + auto-generate
/api/projects/:pid/pages/:id/doc           # Page documentation
/api/projects/:pid/pages/:id/run           # Latest run for page
/api/runs                                  # Run CRUD
/api/runs/:id/explore                      # SSE stream (live exploration)
/api/runs/:id/generate-doc                 # Doc generation
/api/runs/:id/steps                        # Run steps
/api/runs/:id/questions                    # Blocker questions
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

**Backend** (validated at startup, crash if missing):
```
NODE_ENV, PORT, SUPABASE_URL, SUPABASE_SERVICE_KEY,
ANTHROPIC_API_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID
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
- [ ] Stagehand model hardcoded in 2 places (should use env var)
- [ ] `run.service.ts` imports `questions.repository` directly (cross-feature)
- [ ] No tests (Vitest configured but unused)
- [ ] No rate limiting on API endpoints
- [ ] No pagination on list endpoints
- [ ] Legacy RunDashboard/NewRun pages still exist (pre-project model)
- [ ] Page routes don't verify project ownership explicitly (relies on project RLS)

---

*Last updated: current session*
*Stack: Node 20 / TS 5.9 / Stagehand 3 / Anthropic SDK 0.80 / Supabase JS 2.x / Vite 8 / React 19*
