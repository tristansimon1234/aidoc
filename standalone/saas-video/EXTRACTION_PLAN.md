# Extraction Plan — SaaS Video (standalone)

Extracting the marketing-video engine from `aidoc` (Doclee) into a clean
standalone product. Lives in this subfolder until the structure is solid,
then gets copied out into its own repo.

## Stack (same as Doclee — keep velocity)
- Node 20 / TS 5.9 strict / Express 5 / React 19 / Vite 8
- Supabase Postgres + Auth + Storage + RLS
- Gemini 2.5 Flash (script), ElevenLabs (voice + music), Remotion (render, via existing video-service)
- Stripe Checkout (credit packs)
- Vercel deploy (function maxDuration 300s)

## Phase plan & status

- [x] **Phase 1 — Scaffold**: package.json, tsconfig, vite config, ESLint, dir structure, README
- [x] **Phase 2 — Schema**: migrations for `brands`, `marketing_videos`, `user_credits`
- [x] **Phase 3 — Backend engine**: copy + adapt `marketing-video.service`, swap persistence (drop `runs` table → use `marketing_videos`), swap branding (drop `projects` → use `brands` + `BrandingProvider` interface). Copy shared infra (gemini, elevenlabs, video, storage, middleware).
- [x] **Phase 4 — Backend features**: `brand` CRUD, `credits` (balance + Stripe scaffolding), `profile` minimal, `marketing-video` routes
- [x] **Phase 5 — Frontend**: design-system copy, landing, auth, onboarding (brand setup), dashboard, generate flow, billing
- [x] **Phase 6 — Build green + push**: TS strict + ESLint pass + Vite production build, committed to a dedicated branch

## What's left before this can ship

1. **Apply migrations to a Supabase project** — three SQL files in `supabase/migrations/` (initial_schema, credit_rpcs). Verify the `bootstrap_user_credits` trigger fires on signup (sign up a test user, check `select * from user_credits` returns a row).
2. **Set Stripe Price IDs** — replace the placeholder `process.env.STRIPE_PRICE_STARTER/PRO/AGENCY` reads in `credits.routes.ts` with the real Price IDs from the Stripe dashboard. Configure the webhook endpoint at `/api/stripe/webhook` with the events `checkout.session.completed` (paste `STRIPE_WEBHOOK_SECRET` into `.env`).
3. **Verify the script generator works without page-grounded markdown** — the original prompts assume `pageMarkdown` is a documentation snippet, not a marketing brief. Generate 3-5 real videos with real briefs (e.g. Linear, Vercel, Notion features) and judge output quality. If scripts feel generic, the fix is in `marketing-script.generator.ts` — tune the architect prompt to handle "brief" input rather than "doc" input.
4. **Wire a real Remotion render service URL** — re-use Doclee's via `VIDEO_SERVICE_URL` env var to start, then spin up a dedicated one when traffic warrants.
5. **Copy out to a clean repo** — when satisfied, `cp -r standalone/saas-video ~/saas-video && cd ~/saas-video && rm -rf node_modules dist && git init && git add . && git commit -m "initial commit" && git remote add origin <new-repo-url> && git push -u origin main`.

## Known omissions (intentional)

- No password reset flow yet (Supabase Auth supports it; UI not built — add when first user asks).
- No team / org concept — single-user accounts only. Add later if anyone wants to share videos.
- No background jobs / async generation — generate is synchronous (blocks ~2-3 min). Promote to async + jobs row + Realtime updates if Vercel's 300s function timeout becomes a problem.
- No video editing UI post-render. Refine endpoint exists (`POST /api/marketing-videos/:id/edit`) but no UI surface — add when users start asking.
- No usage analytics. Add per-event tracking (PostHog?) once there's a paying user to learn from.
- No Sentry release tag automation. `SENTRY_RELEASE` falls back to `VERCEL_GIT_COMMIT_SHA` which works for Vercel deploys.

## Architectural rewrites vs source

1. **Persistence** — `runs.summary_json.marketingVideo` (JSONB nested) becomes a first-class `marketing_videos` table. `findRunById` / `updateRunSummary(runId, {marketingVideo: ...})` → `findMarketingVideoById(id)` / `updateMarketingVideo(id, patch)`. The service's `runId` parameter becomes `videoId`.
2. **Branding** — `resolveBranding(projectId)` reading from `projects.design` becomes `resolveBranding(brandId)` reading from `brands`. Abstracted behind a `BrandingProvider` interface so the engine doesn't depend on the storage shape directly.
3. **Billing** — drop Doclee's plans/subscriptions/usage_counters/token_costs system. Replace with credit-pack model: each successful render decrements `user_credits.balance` by 1; Stripe webhook tops up.
4. **Auth** — Supabase Auth as-is (single-user accounts, no teams, no MCP, no allowlist).

## Out of scope (vs Doclee)

Doc generation, exploration runs, try-doc testing, chat widget, MCP server, teams, allowlist, analytics, walkthrough/voiceover for docs, MCP tokens. All gone.

## How to use this folder

This is staging — once Phase 6 is done and the product runs end-to-end, copy the entire `standalone/saas-video/` directory into a fresh repo and push.
