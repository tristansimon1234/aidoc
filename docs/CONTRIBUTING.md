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
9. **Track token usage** — increment on every Anthropic call.
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
3. Mount routes in `src/app.ts` AND `api/index.ts`
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
NODE_ENV, PORT, SUPABASE_URL, SUPABASE_SERVICE_KEY,
ANTHROPIC_API_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID
```

Frontend (Vite prefix): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

## Known Technical Debt

- [ ] Exploration instruction built inline in `exploration.service.ts` (should be in `prompt.builder.ts`)
- [x] ~~Stagehand model hardcoded in 2 places~~ — now uses `STAGEHAND_MODEL` constant
- [ ] `run.service.ts` imports `questions.repository` directly (cross-feature)
- [ ] No tests written (Vitest configured but unused)
- [x] ~~No rate limiting~~ — widget endpoint has 30 req/min per API key
- [ ] No pagination on list endpoints
- [ ] RunDashboard and NewRun pages are legacy (pre-project model)
- [ ] Try Doc screenshots not yet linked to report steps
- [ ] Widget: no domain restriction (API key is public)
- [ ] No usage analytics for widget chat
- [x] ~~Widget config slow~~ — edge caching + data-cfg
- [x] ~~Chat admin slow~~ — direct Supabase embedding check
