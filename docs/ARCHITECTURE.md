# Architecture

## Overview

Doclee is an AI-powered documentation platform: users record their screen (or upload a video) and Gemini turns it into a structured product guide with screenshots and voice-over. The same content is then served back to end-users via an embeddable AI chat widget. A Try Doc agent (Stagehand on Browserbase) re-runs the documented flows to flag stale steps.

A SaaS layer sits on top: per-user profile, plan + subscription, monthly token budget, and an admin dashboard for operators.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript 5.9 (strict) |
| Backend | Express 5 (serverless on Vercel) |
| Browser | Stagehand 3 (Browserbase cloud) — Try Doc only |
| AI (exploration / Try Doc) | Claude Sonnet 4 via Stagehand (`STAGEHAND_MODEL`) |
| AI (doc generation, chat, analysis) | Gemini 2.5 Flash |
| AI (voice-over) | ElevenLabs `eleven_multilingual_v2` |
| AI (embeddings) | Gemini embedding model (768-dim vectors) |
| Database | Supabase (Postgres + Auth + Storage + RLS + pgvector) |
| Frontend | React 19 + Vite 8 + React Router 7 + BlockNote 0.47 |
| Validation | Zod 4 |
| Deployment | Vercel (serverless + static) |

## Data Model

```
User (Supabase Auth)
  ├─ Profile (fullName, stripeCustomerId)               ← 1:1, auto-created by trigger
  ├─ Subscription (planId, status, stripeSubscriptionId) ← 1:1 active, auto-created free
  ├─ UsageCounter (periodMonth, feature, count) ×4      ← per-month per-feature counts
  └─ Project (name, baseUrl, context{audience,workflow,quirks}, credentials[],
              design{logoUrl}, widgetApiKey, mcpApiKey)  ← RLS by user_id
       ├─ ChatSession (sessionToken, periodMonth, source∈{widget,app})  ← dedup for chat_sessions counter
       ├─ DocEmbedding (chunk, vector(768))             ← pgvector / RAG
       └─ DocPage (title, slug, parentId, sortOrder, content,
                   briefing{objective,knowledge,resources[]}, status, isPublic)
            ├─ Job (type∈{doc-gen,voiceover,try-doc}, status)  ← async job tracking, Realtime
            └─ Run (featureName, startUrl, goal, status, tokenUsage, summary_json{tryDocReport})
                 ├─ RunStep (action, observation, screenshotPath)
                 ├─ RunQuestion (question, answer)
                 └─ GeneratedDoc (markdownContent, jsonContent)

Plans (seeded: free / founder / team / agency)          ← public read; Stripe IDs nullable
```

## Feature Directory Structure

```
src/features/
  project/          # User workspace CRUD + URL analyzer + widget/MCP key gen
  page/             # Doc page hierarchy + preflight + briefing
                    #   components/TryDocReport.tsx (7-section test report view)
  run/              # Run lifecycle: explore, video analysis, doc gen, voiceover, Try Doc
  exploration/      # Stagehand agent + browser automation (Try Doc)
  documentation/    # Doc generation (prompt + Gemini call) + voice-over
  questions/        # Blocker questions during exploration
  chat/             # RAG chat (project + widget) + walkthrough + MCP server
  profile/          # 1:1 with auth.users — full_name, stripe_customer_id, isAdmin flag
  billing/          # Plans + subscriptions + monthly token budget + overage rates
  admin/            # /admin/usage dashboard, gated by ADMIN_EMAILS
  analytics/        # Per-project chat + doc-view analytics + Gemini insights

src/shared/
  ai/               # Gemini, Anthropic, ElevenLabs clients + prompt builder
  browser/          # Stagehand wrapper
  db/               # Supabase client + storage.repository (upload/download/signed URLs)
  config/           # Zod-validated env vars + isAdminEmail()
  middleware/       # auth (JWT), admin (allowlist), error
  usage/            # incrementUsage RPC + listUsageForCurrentMonth + chat session dedup
  validation/       # Shared Zod schemas

src/ui/
  design-system/    # Tokens, CSS modules, components (barrel export)
                    #   BlockEditor + CalloutBlock — BlockNote with custom callout schema
  features/         # auth, project, page, run, chat, account, admin, docs
  shared/           # API client, RLS-protected db.ts, hooks, jobs, layout
                    #   layout/AppRail — persistent left rail with avatar menu
                    #   layout/AvatarMenu — Settings / View all plans / Admin / Sign out
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

### Try Doc
Try Doc: Stagehand exploration → Gemini structured analysis → persisted JSON report

### Optimistic Updates
Optimistic updates: sidebar drag-and-drop applies changes instantly, syncs to DB in background

### Smart RAG
Smart RAG: greetings/small talk skip embedding search (`needsDocSearch` heuristic)

### Token-based Billing
Every metered op (`doc_run`, `voiceover`, `try_doc`, `chat_sessions`) is incremented in `usage_counters` after success. Token weight, real € COGS, and overage rates live in `src/features/billing/billing.service.ts` as constants (`TOKEN_COSTS`, `EURO_COSTS`, `OVERAGE_EUR`, `OVERAGE_ENABLED_PLANS`) — tunable in code, no migration. Users see one percent (single bar in `/account?tab=billing`); admins see real € COGS and billable overage in `/admin/usage`.

### Quota Enforcement
`enforceQuotaOrThrow(userId)` in `src/shared/middleware/quota.middleware.ts` runs before every metered op (3 chat routes + doc-gen / voiceover / try-doc). It calls `checkQuota()` (`billing.service.ts`) which sums `counters × TOKEN_COSTS` against the plan's `monthlyTokens`. Hard-cap plans (Free / Startup) that hit 100 % get a 402 `QUOTA_EXCEEDED`; overage-enabled plans (Growth / Business) always pass through — they'll be billed via `OVERAGE_EUR` once Stripe is live. The frontend shows a clear upgrade CTA on 402.

### Chat Session Dedup
`widget` and `app` chat traffic share the same `chat_sessions` quota. Each request carries a `sessionToken` (per-tab UUID stored in `sessionStorage`). The `chat_sessions` table's PK `(project_id, session_token, period_month)` ensures `incrementUsage('chat_sessions')` only fires once per token per calendar month. The `source` column splits widget vs in-app for analytics without affecting billing.

### Analytics (write-time classify, SQL-only dashboard, on-demand recommendations)
Every chat turn (user + assistant, across widget / public docs / in-app) is persisted in `chat_messages`. Public doc page views ping `POST /api/docs/:projectId/view`, which inserts into `doc_page_views`. Both tables are service-role write, owner-only read via RLS (`auth.uid() = user_id` on a denormalised `user_id` column).

**Write-time classification** — right after each user chat turn is persisted, `classifyAndStoreUserMessage()` makes a tiny Gemini call (~150 in / 80 out tokens) that writes `sentiment` / `frustration_flag` / `language` / `category` back onto the user-role row. `category` is one of `onboarding | pricing | how-to | error | integration | account | other`. Fire-and-forget: a classification hiccup never slows or breaks the chat reply. These columns are what the dashboard aggregates over.

**Read-time dashboard = pure SQL** — `GET /api/projects/:id/analytics?period=7d|30d|90d` does zero LLM calls. It computes:
- KPIs + source breakdown + sentiment counts via `computeChatStats()`
- Pain points via `computePainPoints()` — `GROUP BY category` on user messages, sorted by `frustrated + negative` volume, with up to 3 example quotes per bucket (frustrated > negative > neutral preference)
- Frustration signals = the 10 most recent user messages where `frustration_flag = true`
- Top viewed public-doc pages, recent-samples list, etc.

Result: dashboard loads in <50ms from a single DB round-trip, no cold-start cache issues, cost scales with message volume (per-classifier call) instead of dashboard opens.

**On-demand recommendations** — `POST /api/projects/:id/analytics/recommendations?period=...` is an explicit owner-initiated action that runs the Gemini synthesis pass on the last 200 user messages (`ANALYTICS_SYSTEM_PROMPT` in `prompt.builder.ts`). 5-minute cooldown per `(project, period)` to avoid accidental double-spend. Returns `{ summary, items[] }` — prioritised actionable fixes (`type: content | product | ux`).

All tracking + classification writes are fire-and-forget so analytics never blocks a chat reply or a page view.

### Admin Allowlist
`/api/admin/*` is gated by the `requireAdmin` middleware which reads `req.userId` (set by auth middleware), looks up the email via `profile.repository.findAuthUserEmail`, and compares against `isAdminEmail(email)` (env-driven, see `ADMIN_EMAILS`). The frontend hides the "Admin · Usage" menu entry unless `profile.isAdmin = true` — the admin email list never leaks to the bundle.

### Error Handling
```typescript
AppError → { error: string, code: string, details?: unknown }
├─ NotFoundError (404)
├─ ValidationError (422)
├─ DatabaseError (500)
└─ generic AppError(message, code, statusCode)  // 401, 402, 403, 429, etc.
```

## API Route Structure

See `CLAUDE.md` § "API Design > Route structure" for the full annotated list. High-level groups:

- `/api/profile` `/api/billing/*` `/api/admin/*` — SaaS layer (auth + admin allowlist)
- `/api/projects/*` `/api/projects/:pid/pages/*` `/api/projects/:pid/chat*` — workspace + content
- `/api/runs/*` — long-running ops: explore, video analyze, doc gen, voice-over, Try Doc
- `/api/widget/:key/*` — public, API-key auth, rate-limited
- `/api/docs/:projectId*` — public docs (per-page `is_public`) + anonymous chat + page-view pings
- `/api/projects/:pid/analytics` — per-project chat + doc-view analytics with AI insights (owner-gated)
- `/api/mcp/*` — Model Context Protocol server for IDE integrations

The same set is mounted twice: in `src/app.ts` for local dev (`npm run dev:server`) and in `api/index.ts` for the Vercel serverless function (with `/api` prefix). Adding a route requires touching both.

## Deployment

- **Vercel**: `api/index.ts` is the serverless entry, `dist/client/` is the static frontend
- **maxDuration**: 300s (exploration can take minutes)
- **Rewrites**: `/api/*` → serverless function, `/*` → SPA fallback
