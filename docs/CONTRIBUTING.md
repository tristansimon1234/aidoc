# Contributing Guide

## Rules (from CLAUDE.md, enforced)

1. **No `any`** — ever. Use `unknown` + type guards.
2. **No Supabase calls outside repositories** — services call repos, repos call Supabase.
3. **No prompt strings outside `prompt.builder.ts`** — exception: exploration instruction in `exploration.service.ts` (dynamic).
4. **No cross-feature service imports** — use dependency injection interfaces.
5. **Zod validates ALL external input** — API requests, AI responses, env vars.
6. **One migration file per schema change** — never edit existing migrations.
7. **No business logic in routes** — routes validate input, call services, return responses.
8. **Always close browser in `finally`** — avoid Browserbase billing.
9. **Track token usage** — increment on every AI call.
10. **Errors propagate, not silently catch** — data-critical operations must throw. Only supplementary operations (enrichment, analytics) can catch and log.
11. **Update docs/** — when changing architecture, workflows, schema, or prompts.

## Adding a New Feature

1. Create directory: `src/features/my-feature/`
2. Create files in this order:
   - `my-feature.types.ts` — interfaces
   - `my-feature.schema.ts` — Zod schemas
   - `my-feature.repository.ts` — DB calls
   - `my-feature.service.ts` — business logic
   - `my-feature.routes.ts` — Express routes
3. Mount routes in `src/shared/middleware/mount-routers.ts` — single edit covers both local dev (`src/app.ts`) and prod serverless (`api/index.ts`).
4. Add frontend pages in `src/ui/features/my-feature/`
5. If adding AI analysis, put prompts in `shared/ai/prompt.builder.ts`
6. If adding Zod validation for AI output, put schemas in the feature's `*.schema.ts`

## Adding a New API Endpoint

1. Define Zod schema in `*.schema.ts`
2. Add repository function in `*.repository.ts`
3. Add service function in `*.service.ts`
4. Add route in `*.routes.ts` (validate → call service → respond)
5. Add to `src/ui/shared/api/client.ts` with proper DTO type

## Adding a Database Column

1. Create migration: `supabase/migrations/YYYYMMDDNNNNNN_description.sql`
2. Update the row interface in `*.repository.ts`
3. Update the domain type in `*.types.ts`
4. Update `mapToX()` function in repository
5. Update Zod schema if the field is user-input
6. Update DTO in `src/ui/shared/api/client.ts`
7. **Document in `docs/DATABASE.md`**

## Frontend Components

- All design system components in `src/ui/design-system/components/`
- Each component has: `Component.tsx` + `Component.module.css`
- Export via barrel `index.ts` (only place barrel exports are allowed)
- Use CSS variables from `globals.css` — never hardcode colors/spacing
- Status colors: always use `tokens.colors.status[status]`

## Environment Variables

All validated at startup via Zod in `src/shared/config/env.ts`:
```
# Required
NODE_ENV, PORT, SUPABASE_URL, SUPABASE_SERVICE_KEY,
GEMINI_API_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID

# Optional in dev, REQUIRED in prod (env.ts throws at boot)
UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  # distributed rate limiting
CRON_SECRET                                         # Authorization: Bearer for /api/cron/*

# Optional
ANTHROPIC_API_KEY    # Only needed for Try Doc (Stagehand)
ELEVENLABS_API_KEY   # Voice-over narration
VIDEO_SERVICE_URL    # External video processing service
ADMIN_EMAILS         # Comma-separated allowlist for /api/admin/*
RESEND_API_KEY       # Transactional email (team invites, doc-ready pings)
EMAIL_FROM           # e.g. "doclee <hello@doclee.tech>"
PUBLIC_APP_URL       # e.g. https://app.doclee.tech (used in email links)
```

Frontend (Vite prefix): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

## Auth / Authorization

Two layers work together:

- **Edge**: `auth.middleware.ts` validates the Supabase JWT on every `/api/*` (non-public) route and attaches `req.userId`.
- **Feature**: because the backend runs with the Supabase service key (RLS bypassed), every handler that touches a resource calls one of:
  - `project.service.assertProjectAccess(projectId, userId)` — returns the project if the caller is a member of its team, else 404.
  - `run.service.assertRunAccess(runId, userId)` — same contract for runs.
  - `assertTeamMembership(teamId, userId)` for pre-resolved team ids.

Public routes (`/widget/*`, `/mcp/*`, `/docs/*`, `/invites/*`) use their own credential (API key, MCP token, invite token) and must not rely on the JWT.

## Outbound HTTP

Any time you `fetch(url)` with a URL that came from user input, go through `src/shared/http/safe-fetch.ts` — it DNS-resolves the target, rejects private/link-local/loopback/cloud-metadata addresses and non-http(s) schemes, and caps body size + timeout. Never call `fetch` directly on a user-provided URL.

## Adding a Heavy Action (> 5s, spawns a browser / big Gemini / ElevenLabs call)

Route every new heavy action through `job.service.ensureExclusiveJob()` in `src/features/run/`:

```ts
const job = await ensureExclusiveJob({
  runId,                  // or null for project-scoped jobs
  pageId: run.docPageId,  // or null for project-scoped
  projectId,
  type: 'my-action',      // add to JobType union if new
  triggeredByUserId: getUserId(req),
})
try {
  const result = await doTheWork()
  await completeJob(job.id)
  res.json(result)
} catch (err) {
  await failJob(job.id, (err as Error).message)
  throw err
}
```

You get for free:
- A 409 `RUN_ALREADY_RUNNING` with the triggering user's name when a teammate already has a job on this page.
- Automatic reclaim of stale jobs (> 10 min — covers Vercel timeouts).
- A row in `jobs` that `JobTracker` shows in the UI and that the frontend can cancel.

Frontend: catch the 409 with `isAlreadyRunningError(err)` and render `AlreadyRunningNotice` — do NOT print the raw error message.

## Error Tracking

`src/shared/observability/sentry.ts` is initialised at the top of both entrypoints. Sentry captures 5xx `AppError` + unhandled errors automatically via the error middleware; you shouldn't need to call `Sentry.captureException` by hand. If you deliberately want to record a non-throwing signal (e.g. a recoverable classification miss), use `Sentry.captureMessage(...)` with a clear tag. The frontend has its own init in `src/ui/shared/observability/sentry.ts` — both are no-ops when the DSN env var is unset.

## Known Technical Debt

See CLAUDE.md § "Known Tech Debt" for the current canonical list. Highlights:

- [ ] Exploration instruction for open-ended runs still built inline in `exploration.service.ts` (other AI prompts now in `prompt.builder.ts`)
- [x] ~~Stagehand model hardcoded~~ — `STAGEHAND_MODEL` constant
- [x] ~~`run.service.ts` imports `questions.repository` directly~~ — lazy-loaded via `getQuestionRepo()`
- [ ] No tests (Vitest configured but unused)
- [ ] No cursor pagination on list endpoints (hard caps applied as safety net: projects 100, members 200, pages 500)
- [ ] Legacy RunDashboard/NewRun pages still in codebase
- [ ] Widget: no domain restriction (Origin check) — API key is public
- [x] ~~Widget chat classifier blocked chat path~~ — moved to hourly Vercel cron (`/api/cron/classify-messages`)
- [x] ~~Sequential per-page indexing~~ — `chat.service.indexProject` runs 5 pages in parallel waves
- [x] ~~MCP tokens stored as plaintext~~ — SHA-256 hash at rest, raw only surfaced once at creation
- [x] ~~IDOR on pages/runs/analytics~~ — routes now assert team membership
- [x] ~~SSRF on analyze-url~~ — `safeFetch` DNS-resolves + blocks private ranges
- [x] ~~Duplicate router mounts~~ — factored into `mount-routers.ts`
- [x] ~~No concurrent-run protection~~ — all heavy actions route through `ensureExclusiveJob`
- [x] ~~No Sentry / error tracking~~ — wired in both entrypoints, no-op when DSN unset
- [ ] Video buffered in memory for voice-over (OOM risk on 300MB+ recordings) — needs streaming to Gemini Files
- [ ] `chat_messages` grows unbounded — needs pruning cron before ~10M rows
- [ ] **Stripe wiring missing** — columns in place, plan switching mutates DB directly
