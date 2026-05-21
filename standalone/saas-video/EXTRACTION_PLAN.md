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
- [ ] **Phase 6 — Polish**: env validation, Sentry wiring, README, deploy config

## Architectural rewrites vs source

1. **Persistence** — `runs.summary_json.marketingVideo` (JSONB nested) becomes a first-class `marketing_videos` table. `findRunById` / `updateRunSummary(runId, {marketingVideo: ...})` → `findMarketingVideoById(id)` / `updateMarketingVideo(id, patch)`. The service's `runId` parameter becomes `videoId`.
2. **Branding** — `resolveBranding(projectId)` reading from `projects.design` becomes `resolveBranding(brandId)` reading from `brands`. Abstracted behind a `BrandingProvider` interface so the engine doesn't depend on the storage shape directly.
3. **Billing** — drop Doclee's plans/subscriptions/usage_counters/token_costs system. Replace with credit-pack model: each successful render decrements `user_credits.balance` by 1; Stripe webhook tops up.
4. **Auth** — Supabase Auth as-is (single-user accounts, no teams, no MCP, no allowlist).

## Out of scope (vs Doclee)

Doc generation, exploration runs, try-doc testing, chat widget, MCP server, teams, allowlist, analytics, walkthrough/voiceover for docs, MCP tokens. All gone.

## How to use this folder

This is staging — once Phase 6 is done and the product runs end-to-end, copy the entire `standalone/saas-video/` directory into a fresh repo and push.
