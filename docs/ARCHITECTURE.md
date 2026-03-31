# Architecture

## Overview

AiDoc is an AI-powered documentation tool that automatically explores web applications and generates user-facing product guides. It uses Stagehand (Browserbase) for browser automation and Claude (Anthropic) for content generation.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript 5.9 (strict) |
| Backend | Express 5 (serverless on Vercel) |
| Browser | Stagehand 3 (Browserbase cloud) |
| AI (exploration) | Claude Sonnet 4 (reliable, via Stagehand `STAGEHAND_MODEL`) |
| AI (doc generation) | Claude Sonnet 4 (quality, direct API) |
| Database | Supabase (Postgres + Auth + Storage + RLS) |
| Frontend | React 19 + Vite 8 + React Router 7 |
| Validation | Zod 4 |
| Deployment | Vercel (serverless + static) |

## Data Model

```
User (Supabase Auth)
  └─ Project (name, baseUrl, context{audience,workflow,quirks}, credentials[])  ← RLS by user_id
       └─ DocPage (title, slug, parentId, sortOrder, content, briefing{objective,knowledge,resources[]}, status)
            └─ Run (featureName, startUrl, goal, status, tokenUsage)
                 ├─ RunStep (action, observation, screenshotPath)
                 ├─ RunQuestion (question, answer)
                 └─ GeneratedDoc (markdownContent, jsonContent)
```

## Feature Directory Structure

```
src/features/
  project/          # User workspace CRUD
  page/             # Doc page hierarchy + auto-generate
  run/              # Exploration run lifecycle
  exploration/      # Stagehand agent + browser automation
  documentation/    # Doc generation (prompt + Claude call)
  questions/        # Blocker questions during exploration

src/shared/
  ai/               # Anthropic client, types, prompt builder
  browser/          # Stagehand client (playwright.client.ts)
  db/               # Supabase client + storage repository
  config/           # Zod-validated env vars
  middleware/       # Auth (Supabase JWT) + error handling
  validation/       # Shared Zod schemas

src/ui/
  design-system/    # Tokens, CSS modules, components (barrel export)
  features/         # Feature-organized pages and components
  shared/           # API client, hooks, layout
```

## File Naming Convention

Each feature follows this pattern:
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
All database calls go through `*.repository.ts`. Services NEVER call Supabase directly.

### Dependency Injection
Services accept deps interfaces instead of importing other feature's services directly.
```typescript
interface RunDeps {
  findRunById: (id: string) => Promise<Run | null>
  updateRunStatus: (id: string, status: RunStatus) => Promise<unknown>
  // ...injected at call site, not imported
}
```

### Prompt Centralization
All AI prompts live in `shared/ai/prompt.builder.ts`. The exploration instruction is the exception (built inline in `exploration.service.ts` because it's dynamic).

### Error Handling
```typescript
AppError → { error: string, code: string, details?: unknown }
├─ NotFoundError (404)
├─ ValidationError (422)
└─ DatabaseError (500)
```

## API Route Structure

```
/api/health                                    GET    (no auth)
/api/projects                                  GET POST
/api/projects/:id                              GET PUT DELETE
/api/projects/:pid/pages                       GET POST
/api/projects/:pid/pages/auto-generate         POST
/api/projects/:pid/pages/reorder               PUT
/api/projects/:pid/pages/:id                   GET PUT DELETE
/api/projects/:pid/pages/:id/doc               GET
/api/projects/:pid/pages/:id/run               GET
/api/runs                                      GET POST
/api/runs/:id                                  GET
/api/runs/:id/explore                          GET (SSE stream)
/api/runs/:id/generate-doc                     POST
/api/runs/:id/steps                            GET
/api/runs/:id/questions                        GET
/api/runs/:id/questions/:qid/answer            POST
/api/runs/:id/doc                              GET
```

## Deployment

- **Vercel**: `api/index.ts` is the serverless entry, `dist/client/` is the static frontend
- **maxDuration**: 300s (exploration can take minutes)
- **Rewrites**: `/api/*` → serverless function, `/*` → SPA fallback
