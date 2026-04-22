# CLAUDE.md — Doclee: AI Documentation Platform

> This file is the source of truth for all code generation in this project.
> Read it fully before writing any code. Never deviate from these rules.
> For detailed docs, see `/docs/ARCHITECTURE.md`, `/docs/WORKFLOWS.md`, `/docs/DATABASE.md`, `/docs/AI_PROMPTS.md`, `/docs/CONTRIBUTING.md`.

---

## Project Overview

Doclee is a **project-based documentation platform** that generates user-facing product guides and deploys them as **embeddable AI chat widgets** on client apps. A **Try Doc** feature lets users test their documentation against the live product — an AI agent follows the doc steps as a naive user and generates a structured quality report.

**Screen recording** is the primary (and only) documentation generation method. Users record their screen (or upload a video) → Gemini analyzes every action → extracts screenshots at key moments → generates structured documentation → ElevenLabs generates voice-over narration.

**Try Doc**: An AI agent (Stagehand) follows the doc steps as a naive user on the live product and generates a structured quality report.

**Chat & Widget**: Users chat with their documentation (RAG-powered). The same chat can be embedded as a widget on client apps via a single `<script>` tag. Chat sessions (widget + in-app) are deduplicated per cookie/month and metered against the user's monthly token budget. The public docs page also has a native "Chat with docs" launcher (no widget key required).

**Analytics**: Per-project **Analytics** tab captures every chat turn (widget / public docs / in-app) and every public-doc page view, then shows KPIs + a Gemini-generated read on sentiment, pain points, content gaps, frustration signals, and actionable recommendations — in the users' own language. Stats come from SQL; insights come from Gemini on the last 200 user messages (10-min cache).

**SaaS billing**: Token-based monthly budget per plan (Free / Founder 19€ / Team 59€ / Agency 149€). Each metered operation consumes a configurable number of tokens. Users see a single usage percent; admins see real € COGS per user and overage billable. Stripe wiring is scaffolded but not yet live.

**Core flow**: Record screen or upload video → AI generates doc with screenshots + voice-over → User reviews/edits → Enable chat widget → Embed on client app

---

## Core Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript 5.9 (strict: true) |
| Backend | Express 5 (serverless on Vercel) |
| Browser Automation | Stagehand 3 (Browserbase cloud browsers) — Try Doc testing |
| AI (voice-over) | ElevenLabs TTS — multilingual voice-over narration for documentation |
| AI (primary) | Gemini 2.5 Flash — doc generation, structure gen, context enrichment, chat, video analysis |
| AI (Try Doc) | Claude Sonnet 4 via Stagehand (`STAGEHAND_MODEL`) — Try Doc testing only |
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
      page.service.ts
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
      voiceover.service.ts         # ElevenLabs TTS voice-over generation
      documentation.routes.ts
    chat/                 # RAG chat + embeddable widget
      chat.types.ts           # ChatMessage, ChatResponse, DocChunk, UserContext
      chat.schema.ts          # Zod schemas for chat request + user context
      chat.repository.ts      # doc_embeddings CRUD + pgvector search
      chat.service.ts         # chunking, indexing, RAG pipeline, suggestions
      chat.routes.ts          # POST /chat, POST /index, GET /suggestions
      widget.routes.ts        # Public API: POST /widget/:key/chat, GET /config, POST /widget/:key/walkthrough
      walkthrough.types.ts    # DomSnapshot for AI-guided walkthrough
    questions/            # Blocker questions during exploration
      questions.types.ts
      questions.schema.ts
      questions.repository.ts
      questions.service.ts
      questions.routes.ts
    profile/              # Per-user profile (1:1 with auth.users)
      profile.types.ts
      profile.schema.ts
      profile.repository.ts   # findProfileById, ensureProfile, findAuthUserEmail
      profile.service.ts
      profile.routes.ts       # GET / PATCH /profile (own row)
    billing/              # Plans + subscriptions + usage % (no Stripe yet)
      billing.types.ts        # Plan, Subscription, UsageSnapshot, PlanId
      billing.schema.ts
      billing.repository.ts   # listPlans, ensureFreeSubscription, updateActiveSubscriptionPlan
      billing.service.ts      # TOKEN_COSTS / EURO_COSTS / OVERAGE_EUR / OVERAGE_ENABLED_PLANS constants
      billing.routes.ts       # GET /plans, GET /summary, POST /subscription/select
    admin/                # Operator dashboard (gated by ADMIN_EMAILS)
      admin.types.ts          # AdminUsageRow, AdminUsageReport
      admin.repository.ts     # listUsageCountersForMonth, listProfiles, listActiveSubscriptions
      admin.service.ts        # getUsageReport(periodMonth) — joins counters + profiles + subs + plans
      admin.routes.ts         # GET /admin/usage?month=YYYY-MM
    mcp/                  # Per-user MCP server (workspace-scoped personal access tokens)
      mcp.types.ts            # McpUserToken, McpUserTokenSummary, McpAuthContext
      mcp.schema.ts           # Zod for token CRUD + every tool's arguments
      mcp.repository.ts       # createToken (hashes at rest), findActiveTokenByValue,
                              # listTokensForUser, revokeToken (soft delete),
                              # touchTokenLastUsed, hashMcpToken
      user-mcp.routes.ts      # Public JSON-RPC 2.0 endpoint — 7 tools (list_projects,
                              # create_project, list_pages, get_page, search_documentation,
                              # create_page, update_page) scoped to (userId, teamId)
      tokens.routes.ts        # Authed CRUD for /api/mcp-tokens
    analytics/            # Per-project chat + doc-view analytics with AI insights
    team/                 # Multi-tenant: teams, members, invites; auto-created personal workspace
      team.types.ts          # Team, TeamMember, TeamInvite, TeamRole
      team.schema.ts         # Zod for create/rename/invite/accept
      team.repository.ts     # CRUD + listMembers + createInvite/acceptInvite
      team.service.ts        # role checks, invite token gen, email sending
      team.routes.ts         # /api/teams/* (authed) + /api/invites/:token (public peek)
      analytics.types.ts      # AnalyticsReport, ChatStats, ViewStats, AiInsights
      analytics.schema.ts     # AnalyticsQuerySchema (7d|30d|90d), AiInsightsSchema, PageViewPingSchema
      analytics.repository.ts # logChatMessages, logPageView, findUnclassifiedUserMessages,
                              # aggregations, sampleUserMessages
      analytics.service.ts    # getReport: SQL stats + 200-msg Gemini pass, 10-min cache;
                              # classifyPendingMessages: hourly cron batch classifier
      analytics.routes.ts     # GET /api/projects/:pid/analytics?period=...
      cron.routes.ts          # POST /api/cron/classify-messages — hourly Vercel cron,
                              # authed via Authorization: Bearer CRON_SECRET
  shared/
    ai/
      gemini.client.ts      # Gemini SDK: generateText(), embedTexts(), analyzeVideoWithGemini()
      anthropic.client.ts   # Anthropic SDK (optional, for Stagehand only)
      anthropic.types.ts
      elevenlabs.client.ts     # ElevenLabs TTS: synthesizeSpeech(), getAvailableVoices()
      prompt.builder.ts     # ALL AI prompts: doc gen, voiceover narration + tone presets,
                            # RAG chat system/user, Try Doc exploration + analysis,
                            # preflight, walkthrough, analytics, message classifier
    browser/
      playwright.client.ts  # launchBrowser(), closeBrowser(), getSessionId()
      browser.types.ts
    db/
      supabase.client.ts
      storage.repository.ts # uploadToStorage(), downloadFromStorage(), getSignedUrl(), createSignedUploadUrl()
    http/
      safe-fetch.ts         # SSRF-safe wrapper — rejects private/link-local IPs,
                            # non-http(s) schemes, caps body size + timeout. Used by
                            # /api/projects/analyze-url.
    middleware/
      auth.middleware.ts     # Supabase JWT validation (attaches req.userId)
      admin.middleware.ts    # requireAdmin — checks email against ADMIN_EMAILS
      error.middleware.ts    # AppError, NotFoundError, ValidationError, DatabaseError
      mount-routers.ts       # Single source of truth for every route mount —
                             # called from both src/app.ts (dev, no prefix) and
                             # api/index.ts (prod, /api prefix).
    usage/
      usage.repository.ts    # incrementUsage RPC + listUsageForCurrentMonth +
                             # registerChatSession (atomic upsert on PK),
                             # findTeamIdByRunId / findTeamIdByProjectId
    config/
      env.ts                # Zod-validated env vars (crash on startup if missing);
                            # isAdminEmail() helper; prod requires Upstash + CRON_SECRET
    validation/
      schemas.ts            # UuidParamSchema (shared)
  ui/
    design-system/
      tokens.ts             # Color, spacing, font, shadow tokens
      globals.css            # CSS variables mapped to tokens
      components/            # Button, Badge, Card, StatusIndicator, CodeBlock,
                             # MarkdownRenderer (handles GFM alert blockquotes as styled callouts),
                             # Field, Spinner, EmptyState,
                             # BlockEditor (BlockNote-based markdown editor with custom CalloutBlock + slash menu),
                             # CalloutBlock (custom BlockNote block: info/tip/warning/danger),
                             # ImageLightbox (click-to-fullscreen image overlay),
                             # ConfirmDialog (portal-based confirm, useConfirmDialog hook),
                             # TableOfContents (floating TOC with heading tracking),
                             # ProgressLoader (multi-step progress indicator)
                             # Each: Component.tsx + Component.module.css
                             # Barrel export in index.ts (only allowed barrel)
    features/
      auth/pages/            # Login.tsx
      project/pages/         # ProjectList, NewProject, ProjectDetail, ProjectSettings, ProjectDesign
      page/
        pages/               # NewPage, PageView (with edit mode + live exploration + video upload), SharePage
        components/           # PageTree, TryDocReport, PreflightPanel, ScreenRecorder,
                             # VideoTimeline, NarratedPlayer
      chat/
        pages/                # ChatPage (full-page chat)
        components/           # ChatPanel (slide-out RAG chat with dynamic suggestions)
      run/
        pages/               # RunDashboard, RunDetail (legacy, pre-project model)
        components/           # RunCard, StepTimeline
      account/
        pages/               # AccountSettings (tabs: Profile, Plan & Billing)
      admin/
        pages/               # AdminUsage (per-user table: counts + AI cost + overage € + quota %)
      analytics/
        pages/               # AnalyticsPage — KPI cards, source breakdown bar, top pages,
                             #   AI insights panel (sentiment, pain points, content gaps,
                             #   frustration signals, recommendations), recent messages log
      docs/
        pages/                # PublicDocs (rendered via MarkdownRenderer)
    shared/
      api/
        client.ts            # Typed API client (DTOs + endpoints): profile, billing, admin, projects, runs, chat
        db.ts                # Frontend-side Supabase repository (RLS-protected reads + simple writes)
        supabase.ts          # Frontend Supabase client (VITE_ env vars)
      hooks/
        useAsync.ts          # Generic async data fetching hook
        useAuth.ts           # Supabase Auth state management
        useChatSessionToken.ts  # Stable per-tab UUID for chat session dedup
      jobs/
        JobContext, JobTracker, JobBadge, useJobRealtime  # Long-running job tracking via DB jobs table + Realtime
      layout/
        Shell.tsx             # App shell with topbar + main; embeds AppRail
        AppRail.tsx           # Persistent left rail (logo, Home, theme toggle, AvatarMenu)
        AvatarMenu.tsx        # Avatar popup: email, Settings, View all plans, Admin · Usage (if admin), Sign out
  app.ts                     # Express app (local dev) — calls mountRouters(app, { prefix: '' })
  server.ts                  # Server startup
api/
  index.ts                   # Vercel serverless entry point — calls mountRouters(app, { prefix: '/api' })
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
2. **No Supabase calls outside a repository** — see the Data Access section below for the full pattern (backend + frontend).
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

## Data Access

Doclee has **two** data-access layers because Supabase is designed to be safely callable from both the server (with the service-role key) and the browser (with the user's JWT + RLS). Each has its own file convention.

### Backend (`src/features/**` + `src/shared/**`)

- **All** `supabase.*` calls live in `*.repository.ts` files. Routes and services must go through a repository.
  - Data: `from('...').select|insert|update|delete`, `rpc('...')` → feature repositories (`project.repository.ts`, `run.repository.ts`, …) or shared ones (`src/shared/usage/usage.repository.ts`, `src/shared/db/storage.repository.ts`).
  - Storage: `storage.from('bucket').upload|download|createSignedUrl` → `src/shared/db/storage.repository.ts` (`uploadToStorage`, `downloadFromStorage`, `getSignedUrl`, `getPublicUrl`).
  - Auth admin: `auth.admin.getUserById` → lives in the feature repository that needs it (see `profile.repository.findAuthUserEmail`).
- Only exception: `src/shared/middleware/auth.middleware.ts` calls `supabase.auth.getUser(token)` to validate the JWT. This isn't a data query, and there's no cleaner home for it.
- Repositories always wrap Postgrest errors in `DatabaseError` and return domain objects (`camelCase`), never raw rows.

### Frontend (`src/ui/**`)

The browser can hit Supabase directly for any table protected by RLS — that's the whole point of RLS. We **don't** route every read through `/api/*`.

- **Reads + simple writes** (projects list, page tree, rename a page, update project) → `src/ui/shared/api/db.ts`. This file is the frontend's equivalent of a repository: all browser-side `supabase.*` calls live here.
- **Everything that needs server-side logic or a secret** (chat, doc generation, voice-over, billing, widget key generation, Stripe later) → `src/ui/shared/api/client.ts`, which calls `/api/*` routes.
- Rule of thumb when adding a UI data call: if it's a plain RLS-filtered SELECT/UPDATE, put it in `db.ts`. If you need to call Gemini, ElevenLabs, Browserbase, Stripe, or to run multiple queries as a transaction, you need a backend route.

---

## AI / Model Rules

### Gemini-first stack
- **Doc generation**: Gemini 2.5 Flash via `generateText()` in `gemini.client.ts`
- **Video analysis**: Gemini 2.5 Flash with Files API for native video understanding
- **Voice-over**: ElevenLabs TTS (`eleven_multilingual_v2`) — generates narration from documentation text
- **Context enrichment**: Gemini 2.5 Flash — fire-and-forget (in `run.service.ts`)
- **Chat (RAG)**: Gemini 2.5 Flash with pgvector-retrieved context
- **Embeddings**: Auto-discovered Gemini embedding model, 768-dim output
- **Try Doc analysis**: Gemini 2.5 Flash — analyzes Stagehand test results into structured JSON report (7 sections)
- **Stagehand (Try Doc)**: `STAGEHAND_MODEL` constant (`anthropic/claude-sonnet-4-20250514`) — requires `ANTHROPIC_API_KEY`

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
See `docs/DATABASE.md` — 14 tables (core: projects, doc_pages, runs, run_steps, run_questions, generated_docs, artifacts; RAG: doc_embeddings; jobs; SaaS: profiles, plans, subscriptions, usage_counters, chat_sessions; MCP: mcp_user_tokens — `token_hash` / `preview` columns added 2026-04-22), 30 migrations.

---

## SaaS / Billing Model

User-facing **monthly token budget** per plan; each metered op consumes a configurable number of tokens. Users see a single percent — never raw counts. Admins see real € COGS per user.

### Plans (seeded in `plans` table)
| Plan | Price | Monthly tokens | Max projects | Persona | Overage |
|---|---|---|---|---|---|
| Free | 0 € | 3 000 | 1 | discovery | hard cap |
| Founder | 19 € | 30 000 | 5 | solo founder / freelance | hard cap |
| Team | 59 € | 100 000 | 15 | Head of Product / Support | pay-as-you-go |
| Agency | 149 € | 500 000 | 50 | AI/Ops consultant, agency | pay-as-you-go |

Hard cap = blocks the operation when over budget (drives upgrades). Pay-as-you-go = lets the user continue, charged at `OVERAGE_EUR` rates.

### Token weights (`src/features/billing/billing.service.ts`)
Tunable in code, no migration needed:
- `TOKEN_COSTS` — weight each op contributes to the monthly budget (`doc_run=100`, `voiceover=300`, `try_doc=400`, `chat_sessions=20`)
- `EURO_COSTS` — real COGS in € per op (`0.10 / 0.30 / 0.40 / 0.02`) — drives the admin "AI cost" column
- `OVERAGE_EUR` — billable rate per extra op once over quota (`0.15 / 0.45 / 0.60 / 0.03`, ≈ 1.5× COGS)
- `OVERAGE_ENABLED_PLANS` — `Set('team', 'agency')`

### Tracking
- Increments wrap each successful metered op in a `try/catch` (a billing glitch never fails an AI op):
  - Doc gen → `run.service.generateDoc` → `incrementUsage(teamId, 'doc_run')`
  - Voice-over → `run.routes /generate-voiceover` → `incrementUsage(teamId, 'voiceover')`
  - Try Doc → `run.service.analyzeTryDoc` → `incrementUsage(teamId, 'try_doc')`
  - Chat (widget + in-app) → `widget.routes` and `chat.routes` → `registerChatSession(...) + incrementUsage(teamId, 'chat_sessions')` only on new session_token per month
- `chat_sessions` table dedupes by `(project_id, session_token, period_month)` PK with a `source ∈ {widget, app}` column for analytics. Same monthly bucket regardless of source. Inserts use `ignoreDuplicates: true` so two concurrent callers (same session, two tabs) can't double-count.

### Admin
- `/admin/usage?month=YYYY-MM` — restricted by `requireAdmin` middleware that checks email against `ADMIN_EMAILS` env var (comma-separated allowlist).
- Returns rows sorted by real € COGS desc: email, plan, per-feature counts, AI cost €, overage € (if applicable), quota %.
- Frontend page: `src/ui/features/admin/pages/AdminUsage.tsx`. Avatar menu shows the link only if `profile.isAdmin = true`.

### Stripe (scaffolded, not live)
- `plans.stripe_price_id`, `subscriptions.stripe_subscription_id`, `profiles.stripe_customer_id` columns are in place but null.
- `POST /billing/subscription/select` mutates DB directly today. When Stripe lands: paid plans redirect to a Checkout Session; the `free` (downgrade) branch stays direct; webhook handler upserts `subscriptions`.

---

## API Design

### Route structure
```
# Account / billing (authenticated)
/api/profile                               # GET PATCH: own profile (full_name)
/api/billing/plans                         # GET: list all plans
/api/billing/summary                       # GET: current plan + subscription + usage %
/api/billing/subscription/select           # POST: switch plan (Stripe Checkout TODO)

# Admin (authenticated + ADMIN_EMAILS allowlist)
/api/admin/usage                           # GET ?month=YYYY-MM: per-user usage report

# User MCP — personal access tokens + JSON-RPC endpoint
/api/mcp-tokens                            # GET list own tokens (masked); POST create { name, teamId } → full token once; DELETE /:id revoke
/api/mcp-user/:token                       # POST (public, token auth, 60/min): JSON-RPC 2.0
                                           # Tools: list_projects, create_project, list_pages, get_page,
                                           #        search_documentation, create_page, update_page
                                           # All tools re-assert project.team_id === token.team_id.

# Teams (authenticated — multi-tenant layer above projects)
/api/teams                                 # GET list; POST create
/api/teams/:id                             # GET (team + members) / PATCH rename / DELETE
/api/teams/:id/members                     # GET list
/api/teams/:id/members/invite              # POST { email, role } → creates invite + emails it
/api/teams/:id/members/:userId             # DELETE remove / PATCH :/role change
/api/teams/invites/:token/accept           # POST (auth) → join team, mark invite accepted
/api/invites/:token                        # GET (public) → peek team name for the accept page

# Analytics (authenticated — project owner only)
/api/projects/:pid/analytics               # GET ?period=7d|30d|90d: chat + doc-view stats + AI insights

# Projects
/api/projects                              # Project CRUD
/api/projects/:pid/pages                   # Page hierarchy
/api/projects/:pid/pages/:id/doc           # Page documentation
/api/projects/:pid/pages/:id/run           # Latest run for page
/api/projects/:pid/widget-key              # POST: generate key, DELETE: disable widget
/api/projects/:pid/mcp-key                 # POST: generate MCP key, DELETE: disable

# Runs
/api/runs                                  # Run CRUD
/api/runs/:id/explore                      # POST: SSE stream (live exploration)
/api/runs/:id/cancel                       # POST: Cancel running exploration
/api/runs/:id/analyze-video                # POST: Gemini video analysis
/api/runs/:id/generate-doc                 # POST: Doc generation (bumps doc_run usage)
/api/runs/:id/generate-voiceover           # POST: ElevenLabs voice-over (bumps voiceover usage)
/api/runs/:id/regenerate-segment           # POST: Regenerate single voiceover segment
/api/runs/:id/voiceover-segments           # PUT: Adjust voiceover segment timing
/api/runs/:id/trim-video                   # POST: Trim video to time range
/api/runs/:id/signed-upload-url            # POST: Get signed URL for direct upload
/api/runs/:id/steps/:idx/screenshot        # POST: Update step screenshot path
/api/runs/:id/steps                        # Run steps
/api/runs/:id/questions                    # Blocker questions

# Chat (authenticated)
/api/projects/:pid/chat                    # POST: RAG chat (bumps chat_sessions on new sessionToken)
/api/projects/:pid/chat/index              # POST: Index/re-index doc embeddings
/api/projects/:pid/chat/suggestions        # GET: Dynamic suggestions (cached 1h)

# Try Doc
/api/runs/:id/analyze-try                  # POST: Gemini analysis (bumps try_doc usage)
/api/projects/:pid/pages/:id/test-report   # GET: latest test report for page
/api/projects/:pid/pages/:id/preflight     # POST: pre-flight check before Try Doc
/api/projects/:pid/pages/:id/full          # GET: combined page + run + doc data

# Project assets
/api/projects/:pid/logo                    # POST: upload project logo
/api/projects/:pid/analyze-url             # POST: auto-fill project from URL

# Public docs (no auth — per-page is_public flag)
/api/docs/:projectId                       # GET: public pages list + chatEnabled flag
/api/docs/:projectId/:slug                 # GET: public page content
/api/docs/:projectId/chat                  # POST: anonymous chat (rate-limited per IP, logs chat_messages)
/api/docs/:projectId/chat/status           # GET: hasEmbeddings check (for the ChatPanel empty-state)
/api/docs/:projectId/chat/suggestions      # GET: cached chat suggestions
/api/docs/:projectId/view                  # POST: page view ping {pageSlug, sessionToken} (rate-limited 120/min)

# Widget (public — API key auth, no JWT)
/api/widget/:key/chat                      # POST: Public chat (rate limited 30/min, bumps chat_sessions)
/api/widget/:key/config                    # GET: Widget config + suggestions
/api/widget/:key/walkthrough               # POST: AI-guided walkthrough (rate limited 10/min)

# Cron (authed via Authorization: Bearer CRON_SECRET — called by Vercel on schedule)
/api/cron/classify-messages                # POST/GET: hourly sentiment/frustration classifier for chat messages
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
- `MarkdownRenderer` for rich doc display (react-markdown). Detects GitHub-style alert blockquotes (`> [!TIP]`, `> [!WARNING]`, etc.) and renders them as styled callouts.
- `CodeBlock` for raw code display
- `BlockEditor` — BlockNote (TipTap/ProseMirror) markdown editor with auto-save. Custom schema includes the `CalloutBlock` for admonitions; slash menu has `/info`, `/tip`, `/warning`, `/danger` entries. Code blocks render with a forced dark theme (`#161616` bg + `#f5f5f5` text) since the editor-wide transparent override otherwise leaks onto them.
- `CalloutBlock` — custom BlockNote block (info/tip/warning/danger). Round-trips to markdown as GFM alert blockquotes (`> [!TIP]\n> content`); on load, plain quote blocks matching that pattern are promoted back to callouts.
- `ConfirmDialog` (via `useConfirmDialog` hook) — portal-based confirm with danger/primary variants
- `ProgressLoader` — multi-step progress with animated indicators
- `TableOfContents` — floating side indicator, expands on hover to show headings
- `ImageLightbox` (via `useImageLightbox` hook) — click any doc image to fullscreen

### Frontend patterns
- Feature-first organization mirrors backend
- `useAsync` hook for data fetching
- `useAuth` hook for Supabase Auth
- `useChatSessionToken(projectId)` — stable per-tab UUID for chat session dedup (mirrors widget.js)
- `Shell` layout with `fullWidth` option for project sidebar; embeds the persistent `AppRail`
- `AppRail` — narrow left rail visible on every authenticated page. Logo + Home + theme toggle + `AvatarMenu` at the bottom.
- `AvatarMenu` — popup with user email, Settings, View all plans, **Admin · Usage** (only when `profile.isAdmin`), Sign out.
- SSE streaming via fetch + ReadableStream for live exploration

---

## Environment Variables

**Backend** (validated at startup via Zod, see `src/shared/config/env.ts`):
```
# Required
NODE_ENV, PORT, SUPABASE_URL, SUPABASE_SERVICE_KEY,
GEMINI_API_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID

# Optional
ANTHROPIC_API_KEY    # Only needed for Try Doc testing (Stagehand)
ELEVENLABS_API_KEY   # Optional — voice-over narration
VIDEO_SERVICE_URL    # Optional — external video processing service
ADMIN_EMAILS         # Comma-separated allowlist for /api/admin/* routes
                     # e.g. ADMIN_EMAILS=you@example.com,partner@example.com
RESEND_API_KEY       # Optional — transactional email (team invites, doc-ready pings) via Resend
EMAIL_FROM           # e.g. "doclee <hello@doclee.tech>" — sender used with Resend
PUBLIC_APP_URL       # e.g. https://app.doclee.tech — used to build invite + doc-ready review links
                     # Auth emails (signup/reset/magic link) go through Supabase SMTP
                     # configured in the Supabase dashboard; see docs/EMAIL_TEMPLATES.md.
UPSTASH_REDIS_REST_URL     # Required in prod (env.ts throws on boot); in dev,
UPSTASH_REDIS_REST_TOKEN   # missing both falls back to an in-memory limiter.
                           # Prod fallback is bypassable across cold starts, so we fail fast.
CRON_SECRET                # Required in prod — Vercel injects it as
                           # `Authorization: Bearer ${CRON_SECRET}` on every cron hit,
                           # and /api/cron/* rejects anything else.
```

**Frontend** (Vite prefix):
```
VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
```

---

## Deployment

- **Platform**: Vercel (Pro — required for `maxDuration: 300` and cron jobs)
- **Backend**: `api/index.ts` serverless function (maxDuration: 300s)
- **Frontend**: Vite build → `dist/client/`
- **Rewrites**: `/api/*` → serverless, `/*` → SPA fallback
- **Cron**: `vercel.json` → `/api/cron/classify-messages` hourly (chat message sentiment/frustration classifier)
- Auth: Supabase JWT with RLS + team_members membership check on backend routes

---

## Known Tech Debt

- [ ] Exploration instruction built inline (should move to prompt.builder.ts). All other AI prompts now live in `prompt.builder.ts` — voiceover narration, RAG chat, Try Doc exploration + analysis, preflight, walkthrough, analytics, classifier.
- [x] ~~Stagehand model hardcoded in 2 places~~ — now uses `STAGEHAND_MODEL` constant
- [x] ~~No rate limiting~~ — `src/shared/rate-limit/rate-limit.ts` wraps `@upstash/ratelimit` sliding-window limiters with an in-memory fallback for local dev. Wired on widget chat (30/min), widget walkthrough (10/min), public-docs chat (30/min), public-docs view (120/min), MCP (30/min). `env.ts` **requires** `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` in prod (throws at boot otherwise).
- [x] ~~`run.service.ts` imports `questions.repository` directly~~ — now loaded lazily via a single indirection (`getQuestionRepo()`).
- [ ] No tests (Vitest configured but unused)
- [ ] No cursor-based pagination on list endpoints. Hard caps applied as a safety net: projects 100, team members 200, pages 500 per project, chat rows 5k/analytics query. Above those, callers see truncated data rather than a slow request.
- [ ] Legacy RunDashboard/NewRun pages still in codebase (auto-explore removed but pages remain). Server-side `GET /api/runs` returns 404 now to stop leaking the full run list.
- [ ] Widget: no domain restriction (Origin header check) — API key is public
- [x] ~~Chat suggestions cache is in-memory~~ — widget endpoint has in-memory cache + edge caching
- [x] ~~No usage analytics/logging for widget chat messages~~ — `chat_sessions` counter tracks widget + in-app sessions per month
- [ ] Try Doc report could include screenshots from Stagehand steps
- [x] ~~Widget config slow~~ — edge caching + inline data-cfg attribute
- [x] ~~Quota enforcement not active~~ — `enforceQuotaOrThrow` + `requireQuota` in `src/shared/middleware/quota.middleware.ts`. Free / Startup return 402 `QUOTA_EXCEEDED` at 100 %; Growth / Business pass through (overage billed). Wired on all 3 chat routes + doc-gen / voiceover / try-doc.
- [x] ~~Auth bypass / IDOR~~ — page / run / analytics routes now check team membership (previously compared `project.userId` only, broke for team members and let any authed user enumerate runs).
- [x] ~~SSRF on /api/projects/analyze-url~~ — `src/shared/http/safe-fetch.ts` DNS-resolves the target, rejects private / link-local / loopback / cloud-metadata ranges and non-http(s) schemes.
- [x] ~~Invited email leaked on public invite peek~~ — `GET /api/invites/:token` returns team + inviter only. Accept flow still validates `auth.email === invite.email` server-side.
- [x] ~~MCP tokens stored as plaintext~~ — `token_hash` (SHA-256) + `preview` columns; raw token only surfaced once at creation. Migration: `20260422000001_hash_mcp_tokens_at_rest.sql`.
- [x] ~~`registerChatSession` SELECT-then-INSERT race~~ — now single INSERT with `ignoreDuplicates: true` on the PK.
- [x] ~~Gemini retry too aggressive for SSE~~ — `10/20s × 2` backoff (was `30/60/90s × 3`) so exploration timeouts don't leave runs stuck `running`.
- [x] ~~Sequential per-page indexing~~ — `chat.service.indexProject` runs 5 pages in parallel (Promise.allSettled waves). 100-page project ~12× faster.
- [x] ~~Classifier blocked chat path~~ — now hourly Vercel cron drains unclassified user messages. Chat response latency no longer bounded by a second Gemini call; analytics lags ≤ 1h.
- [ ] **Stripe wiring missing** — `plans.stripe_price_id`, `subscriptions.stripe_subscription_id`, `profiles.stripe_customer_id` columns are in place but plan switching mutates DB directly. Need Checkout Session + webhook handler.
- [ ] Code blocks have no syntax highlighting (Shiki = ~2 MB to bundle, deferred). Language picker also not yet exposed.
- [x] ~~`src/app.ts` and `api/index.ts` duplicate router mounts~~ — factored into `src/shared/middleware/mount-routers.ts`; both entrypoints call it with the right prefix.
- [ ] **Scale bottlenecks surfaced by the pre-launch audit, not yet addressed**:
  - [ ] Embeddings stored via `JSON.stringify()` cast to `vector(768)` — index works, but a native `pgvector-node` path would drop the parsing overhead on bulk inserts. Defer until latency signals justify it.
  - [ ] RLS `user_team_ids()` subquery re-executed on every SELECT — at ~100 concurrent chats it adds measurable latency. Fix is either Postgres-side (make the function `STABLE`) or client-side (cache the team ids on the JWT). Needs an architecture call.
  - [ ] Video is buffered to a `Buffer` in memory for voice-over; a 300 MB recording OOMs Vercel. Needs streaming to Gemini Files API, or a hard client-side cap on upload size.
  - [ ] No concurrent-run protection on Browserbase — double-clicking Explore spawns two runs. Needs a unique constraint or in-app lock on `(page_id, status='running')`.
  - [ ] No Sentry / error tracking. Blind to production failures until a design partner reports them.
  - [ ] `chat_messages` grows unbounded. Need a pruning cron or partition scheme before ~10M rows degrade analytics queries.
- [ ] **Chat RAG quality — deferred batches** (already landed: top-20 retrieval, conversational query rewriting, temperature 0.3, hierarchy breadcrumbs, Gemini-as-judge reranking, Pro model routing on complex queries). Still on the shelf:
  - [ ] Hybrid BM25 + vector search (pgvector + `tsvector`). Helps on queries with exact terms / proper nouns that embed weakly.
  - [ ] Multi-query retrieval — generate 3 query variants via Gemini, union results, dedup. Lifts recall on vague phrasing.
  - [ ] Numbered `[1]` citations + clickable source footer. Prompts Gemini to tag claims; frontend renders as deep-links.
  - [ ] Semantic chunking by heading (currently ~500-token fixed-size w/ heading boundaries). Would re-embed the whole corpus; wait until there's enough signal that recall is the bottleneck.
  
  Park until design-partner feedback shows which specific failure mode dominates — no point optimizing recall / reranking / citations blind.

---

*Last updated: 2026-04-22*
*Stack: Node 20 / TS 5.9 / Gemini 2.5 Flash / Stagehand 3 (beta) / Supabase JS 2.x + pgvector / Vite 8 / React 19 / BlockNote 0.47*
