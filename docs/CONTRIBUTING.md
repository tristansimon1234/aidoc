# Contributing Guide

## Rules (from CLAUDE.md, enforced)

1. **No `any`** — ever. Use `unknown` + type guards.
2. **No Supabase calls outside repositories** — services call repos, repos call Supabase. (Known exceptions tracked under tech debt.)
3. **No prompt strings outside `prompt.builder.ts`** — exceptions: the exploration instruction (`exploration.service.ts`), the narration prompt (`run.routes.ts` `/generate-voiceover`), and the URL-analysis prompt (`project.routes.ts` `/analyze-url`). Tracked as tech debt.
4. **No cross-feature service imports** — use dependency injection interfaces (`RunDeps`, `DocDeps`). Known exception: `run.service.ts` imports `questions.repository` directly (tech debt).
5. **Zod validates ALL external input** — API requests, AI responses, env vars.
6. **One migration file per schema change** — never edit existing migrations.
7. **No business logic in routes** — routes validate input, call services, return responses. Known exceptions: `/projects/analyze-url`, `/runs/:id/generate-voiceover`, and `/projects/:id/usage` still contain significant inline logic (tech debt).
8. **Always close browser in `finally`** — avoid Browserbase billing.
9. **Track token usage** — increment on every AI call.
10. **Errors propagate, not silently catch** — data-critical operations must throw. Only supplementary operations (enrichment, auto-indexing, analytics) can catch and log.
11. **Update docs/** — when changing architecture, workflows, schema, or prompts.

## Adding a New Feature

1. Create directory: `src/features/my-feature/`.
2. Create files in this order:
   - `my-feature.types.ts` — interfaces.
   - `my-feature.schema.ts` — Zod schemas.
   - `my-feature.repository.ts` — DB calls.
   - `my-feature.service.ts` — business logic.
   - `my-feature.routes.ts` — Express routes.
3. Mount routes in `src/app.ts` **and** `api/index.ts`.
4. Add frontend pages in `src/ui/features/my-feature/`.
5. If adding AI analysis, put prompts in `shared/ai/prompt.builder.ts`.
6. If adding Zod validation for AI output, put schemas in the feature's `*.schema.ts`.

## Adding a New API Endpoint

1. Define Zod schema in `*.schema.ts`.
2. Add repository function in `*.repository.ts`.
3. Add service function in `*.service.ts`.
4. Add route in `*.routes.ts` (validate → call service → respond).
5. Add to `src/ui/shared/api/client.ts` with a proper DTO type.

## Adding a Database Column

1. Create migration: `supabase/migrations/YYYYMMDDNNNNNN_description.sql`.
2. Update the row interface in `*.repository.ts`.
3. Update the domain type in `*.types.ts`.
4. Update the `mapToX()` function in the repository.
5. Update the Zod schema if the field is user input.
6. Update the DTO in `src/ui/shared/api/client.ts`.
7. **Document in `docs/DATABASE.md`** (migrations table + relevant table section).

## Long-Running Work (Jobs)

When adding background work (anything that takes longer than an HTTP round-trip):
1. Insert a row into `jobs` via `job.repository.ts` (`type: 'doc-gen' | 'voiceover' | 'try-doc' | …`).
2. Update status to `completed` / `failed` when done (always with `.catch(() => {})` guard around the final update so the caller's error is preserved).
3. The frontend subscribes to Supabase Realtime on `jobs` via `useJobRealtime`; the `JobTracker` renders the floating indicator automatically.

## Video Operations

- Never run FFmpeg in the serverless function. Use `src/shared/video/video.client.ts` to call the external microservice (`video-service/`).
- Always check `isVideoServiceConfigured()` before calling; degrade gracefully when `VIDEO_SERVICE_URL` is unset.

## Frontend Components

- All design-system components live in `src/ui/design-system/components/`.
- Each component has: `Component.tsx` + `Component.module.css`.
- Export via the barrel `index.ts` (the only place barrel exports are allowed).
- Use CSS variables from `globals.css`; never hardcode colors / spacing.
- Status colors: always use `tokens.colors.status[status]`.

## Environment Variables

All validated at startup via Zod in `src/shared/config/env.ts`:
```
# Required
NODE_ENV, PORT, SUPABASE_URL, SUPABASE_SERVICE_KEY,
GEMINI_API_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID

# Optional
ANTHROPIC_API_KEY   # Required only for Try Doc (Stagehand with Claude Sonnet 4)
ELEVENLABS_API_KEY  # Required only for voice-over narration
VIDEO_SERVICE_URL   # URL of the FFmpeg microservice (video-service/). If unset,
                    # video conversion / frame extraction / trimming / concat are skipped.
```

Frontend (Vite prefix): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

## Testing & Evals

- `npm test` → runs all Vitest tests.
- `npm run eval` → runs the documentation-quality evals (`evals/eval.test.ts`) against fixtures (`evals/fixtures/*.json`) and criteria (`evals/criteria/*.json`), scored by `scoreHeuristics` + `scoreLlmJudge`.
- Add a new eval: drop `my-case.json` into `evals/fixtures/` and a matching rubric into `evals/criteria/`.

## Known Technical Debt

- [ ] Exploration instruction built inline in `exploration.service.ts` (should be in `prompt.builder.ts`).
- [x] ~~Stagehand model hardcoded in 2 places~~ — uses `STAGEHAND_MODEL` constant.
- [ ] `run.service.ts` imports `questions.repository` directly (cross-feature).
- [ ] `run.service.ts` accesses Supabase Storage directly for `briefing-files` downloads (should live in a repository).
- [ ] `project.routes.ts` calls Supabase directly in `/usage` (should live in `project.repository.ts`).
- [ ] Narration and URL-analysis prompts are inline (should move to `prompt.builder.ts`).
- [ ] Only evals are in place; no unit tests for services / repositories.
- [x] ~~No rate limiting~~ — widget chat (30 req/min), widget walkthrough (10 req/min), MCP (30 req/min) all rate-limited.
- [ ] No pagination on list endpoints.
- [ ] Widget API key and MCP API key are public — no domain / origin restriction.
- [ ] No usage analytics / logging for widget chat messages.
- [ ] Try Doc report could include screenshots from Stagehand steps for failed steps inline.
- [x] ~~Widget config slow~~ — edge caching + inline `data-cfg`.
- [x] ~~Chat admin slow~~ — direct Supabase embedding check.
