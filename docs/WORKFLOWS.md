# Workflows

## Core User Journey

```
Login → Projects → Create Project → Record/Upload Video → AI Generates Docs →
Edit Docs → Generate Voice-over → Chat with Docs → Enable Widget → Embed on Client App
```

## Video-to-Doc Flow (Recommended)

**Trigger**: User clicks "Upload a screen recording" in the Generate tab
**Flow**:
1. Frontend creates a run (`POST /api/runs`)
2. Video uploaded to Supabase Storage via signed URL (`POST /runs/:id/signed-upload-url`)
3. Backend sends video to Gemini 2.5 Flash for analysis (`POST /runs/:id/analyze-video`)
4. Gemini returns structured steps: timestamp, screen description, user action, narration
5. Frontend extracts JPEG frames at exact Gemini timestamps (Canvas API, ~25 frames max)
6. Frames uploaded to Supabase via signed URLs, linked to run steps
7. Gemini generates documentation from enriched steps (`POST /runs/:id/generate-doc`)
8. Doc auto-copied to `doc_pages.content`, page embeddings auto-indexed for chat

## Chat with Documentation (RAG)

**Trigger**: User clicks 💬 in project sidebar
**Flow**:
1. `POST /chat/index` — checks if embeddings exist, indexes if not
2. `GET /chat/suggestions` — Gemini generates 6 project-specific questions (cached 1h)
3. User sends message → `POST /chat`
4. Smart RAG: `needsDocSearch()` skips embedding search for greetings, small talk, and continuation messages
5. Query embedded with Gemini embedding model → pgvector cosine search → top 10 chunks
6. Gemini generates answer with project context (name, audience, features, knowledge base)
7. Response includes: answer, source pages (clickable), follow-up suggestions (clickable)
8. Step-by-step: for "how do I" questions, gives 2-3 steps then proposes to continue
9. Admin chat checks embeddings directly via Supabase (bypasses Vercel cold start)

## Embeddable Widget

**Setup**: Project Settings → Embed Widget → Generate API Key → Copy snippet
**Integration**:
```html
<script src="https://app.doclee.tech/widget.js"
  data-key="aidoc_xxx"
  data-user-name="{{USER_NAME}}"
  data-user-email="{{USER_EMAIL}}"
  data-user-plan="{{USER_PLAN}}"
></script>
```
**Runtime**:
1. Widget loads config from `GET /api/widget/:key/config` (project name + suggestions)
2. Widget config includes inline design via `data-cfg` attribute for instant theming (no flash)
3. Config endpoint uses edge caching (`Cache-Control: s-maxage=300`)
4. Auto-detects current URL (`window.location.href`) for page-aware suggestions
5. Messages sent to `POST /api/widget/:key/chat` (rate limited 30 req/min)
6. Same RAG pipeline as internal chat, with user context for personalization
7. AI-guided walkthrough via `POST /api/widget/:key/walkthrough` (rate limited 10/min)
8. Suggestions cached in-memory with 1h TTL
9. Floating button (bottom-right) + popup panel, dark theme, mobile responsive

## 1. Project Creation

**Trigger**: User clicks "New Project"
**Flow**:
1. User fills: name, base URL, description, product context, test credentials
2. `POST /api/projects` → creates project with `user_id` (RLS isolation)
3. Redirect to project detail page

**Key fields**:
- `context`: injected into ALL AI prompts (exploration + doc gen)
- `credentials`: injected as Stagehand variables for login

## 2. Auto-generate Documentation Structure

**Trigger**: User clicks "Auto-generate structure" on empty project
**Flow**:
1. `POST /api/projects/:id/pages/auto-generate`
2. Stagehand launches browser → navigates to project `baseUrl`
3. `session.extract()` gets raw page text (no AI call)
4. Gemini 2.5 Flash analyzes content → proposes 5-15 pages with hierarchy
5. Pages created in DB: top-level first, then children
6. Frontend refreshes sidebar tree

**AI call**: 1x Gemini 2.5 Flash (structure proposal)

## 3. Page Exploration

**Trigger**: User clicks "Explore & Document" on a page (also used for Try Doc testing — see section 10)
**Flow**:
1. `POST /api/runs` → creates run linked to page (`docPageId`)
2. `GET /api/runs/:id/explore` → SSE stream begins
3. Backend:
   a. Launches Stagehand browser (Browserbase cloud)
   b. Navigates to page's `startUrl`
   c. Fetches project context + page siblings + credentials
   d. Stagehand agent executes with full context
   e. Each tool call → `onStepFinish` callback:
      - Save step to DB (action, observation, screenshot)
      - Emit SSE event to frontend
   f. Agent finishes → run status updated
   g. Browser closed (always, to avoid billing)
4. Frontend receives SSE events:
   - `live`: show browser iframe
   - `status`: update status message
   - `step`: append to live feed
   - `done/blocked/error`: exploration ended

**AI calls**: ~25x Claude Sonnet 4 via Stagehand (one per agent step)

## 4. Documentation Generation

**Trigger**: Automatically after exploration, or "Generate Documentation" button
**Flow**:
1. `POST /api/runs/:id/generate-doc`
2. Backend:
   a. Fetch run + steps + questions + project context + page siblings
   b. Resolve screenshot signed URLs from Supabase Storage
   c. Build rich prompt with step data, screenshots, cross-page context
   d. Call Gemini 2.5 Flash with `max_tokens: 16384`
   e. Parse response: markdown + `---JSON---` + self-assessment
   f. Save to `generated_docs` table
   g. Copy markdown to `doc_pages.content` (editable copy)
3. Frontend refreshes page → shows rendered markdown

**AI call**: 1x Gemini 2.5 Flash (doc generation)

## 5. Cross-Page Awareness

**When**: During both exploration and doc generation
**What the AI receives**:
- `projectContext`: product description, who it's for, terminology
- `tableOfContents`: all sibling pages with status and slug
- `existingPageSummaries`: first 200 chars of each sibling's content
- `credentials`: test login credentials as Stagehand variables
- `customPrompt`: user's page-specific instructions

**Effect**: Gemini can reference other pages (`See [Login Guide](/login)`) and avoid duplicating content.

## 5b. Context Learning (Auto-Enrichment)

**When**: After each documentation generation
**Flow**:
1. After doc gen, a lightweight Gemini 2.5 Flash call analyzes the generated markdown
2. Extracts structured knowledge: site structure, navigation, terminology, features
3. Merges with existing `projects.discovered_context` (enrichment, not replacement)
4. Future explorations receive this enriched context in their prompts

**What gets stored in `discovered_context`**:
```json
{
  "lastUpdated": "2026-03-25T...",
  "siteStructure": ["/", "/pricing", "/admin"],
  "navigation": ["Home", "Pricing", "Settings"],
  "terminology": {"KPI": "Key Performance Indicator"},
  "features": ["User auth", "Dashboard", "Data import"],
  "summary": "A data analytics platform with..."
}
```

**Cost**: ~$0.001 per enrichment (Gemini 2.5 Flash, small prompt)
**Effect**: The more you document, the smarter the agent gets about your product.

## 6. Resume Exploration

**Trigger**: User clicks "Continue Exploration" on a blocked/failed page
**Flow**:
1. Reuses the same run ID
2. Backend fetches existing steps → groups by URL
3. New Stagehand session (fresh browser, old session is closed)
4. Agent instruction includes:
   ```
   ## Pages Already Explored (8 steps total)
   - /pricing: 3 steps (viewed table, clicked plans, scrolled)
   - /about: 2 steps (read content, captured screenshot)

   Focus on sections you haven't explored yet.
   ```
5. Agent navigates to `startUrl` and continues from there

## 7. Manual Editing

**Trigger**: User clicks "Edit" on a page
**Flow**:
1. Textarea appears with current `doc_pages.content`
2. User edits markdown directly
3. "Save" → `PUT /api/projects/:pid/pages/:id { content: "..." }`
4. Content is the source of truth for display
5. Re-exploring overwrites `content` with new AI output

## 8. Page Organization

**In sidebar**:
- Sidebar supports drag-and-drop reorder with optimistic updates
- `[...]` menu on hover → Move up, Move down, Move to parent, Delete
- Context menu for nesting pages (Move inside... / Move to root)
- Move up/down: swap `sortOrder` with sibling
- Move to parent: update `parentId` via `PUT /api/projects/:pid/pages/:id`
- Delete: `DELETE /api/projects/:pid/pages/:id`
- Child page links shown at bottom of page content (Notion-style)

## 9. Self-Assessment + Suggestions

**After doc generation**, the JSON contains:
```json
{
  "selfAssessment": {
    "overallCompleteness": 65,
    "gaps": [{ "area": "Checkout", "reason": "Login required", "severity": "major" }],
    "nextSteps": [{ "suggestion": "Payment Flow", "priority": "high" }],
    "structuralSuggestions": [{ "type": "split", "details": "Page too long" }]
  }
}
```

Frontend renders:
- Completeness bar (green/amber/red)
- Gaps list with severity badges
- "Suggested Next Pages" with [Create Page] buttons
- Structural suggestions (merge, split, move, rename)

## 10. Try Doc (Documentation Testing)

1. User clicks "Test" tab on a page → clicks "Run Test"
2. System creates a run with `[Test]` prefix and naive-user prompt
3. Stagehand agent opens the app in a cloud browser
4. Agent follows documentation steps exactly as a naive user (no gap-filling)
5. SSE events stream live progress (steps + browser iframe)
6. After exploration: Gemini 2.5 Flash analyzes all steps vs doc content
7. Generates structured 7-section report: summary, step results, failures (doc vs product), doc issues, UX insights, recommendations, scores
8. Report stored in `runs.summary_json.tryDocReport`
9. Test tab shows persisted report with verdict badge (green/red/amber)

## 11. Voice-over Narration

**Trigger**: User clicks "Generate voice-over" in the Walkthrough tab
**Flow**:
1. Frontend sends `POST /api/runs/:id/generate-voiceover` with voice ID, tone, video duration
2. Backend downloads video from Supabase Storage
3. Merges step timestamps into segments (min 3s gap to avoid micro-segments)
4. Gemini 2.5 Flash generates narration script watching the actual video, split into `[SECTION N]` markers
5. Word count enforced per segment based on time budget (~2 words/sec)
6. ElevenLabs TTS (`eleven_multilingual_v2`) synthesizes each segment as MP3
7. Segments concatenated with silence padding into single `voiceover.mp3`
8. Stored in `runs.summary_json.voiceover` (audioPath, audioUrl, segments[])
9. Frontend shows narrated video player with synced timeline

**Editing**:
- Click segment text → edit → `POST /runs/:id/regenerate-segment` re-synthesizes that segment only
- Drag timeline handles → `PUT /runs/:id/voiceover-segments` adjusts timing
- "Regenerate" button re-generates entire voice-over (confirmation dialog if existing)

**Cost**: ~$0.005 per segment (ElevenLabs) + ~$0.02 Gemini narration script

## 11b. Marketing Video Generation

**Trigger**: User opens the **Marketing** tab on a page and clicks "Generate marketing video"

This is a separate output from the walkthrough video (the recorded screen capture + voice-over). It's a 45-second branded promo built FROM the page's content — designed for landing pages, social posts, sales decks. The Marketing tab sits next to Walkthrough in the page header but the two never share assets.

**Flow** (async via Vercel `waitUntil`, completion via Realtime on `jobs`):
1. Frontend `POST /api/runs/:id/marketing-video?async=1` with options (visualMode, tone, voiceId, music choice + volume, optional userPrompt brief)
   - If the page has no run yet (manually-typed content, no recorded video), the panel calls `api.runs.create({ docPageId, ... })` first to spin up a stub run; visualMode is locked to `mocks` (no screenshots available).
2. Backend `enforceQuotaOrThrow(teamId)` — Free / Founder hit a 402 `QUOTA_EXCEEDED` if over budget; Team / Agency pass through (overage billed later).
3. Backend creates a row in `jobs` (type=`marketing-video`), returns 202 with `{ runId, jobId, status: 'running' }`.
4. Inside `waitUntil`, the pipeline runs:
   - **Script** — Gemini 2.5 Pro (mocks mode) or 2.5 Flash (screenshots mode) generates a JSON script: hook + 3-4 scenes + CTA, with audio-tag voice-over lines and either `mockCode` (TSX) per scene OR `screenshotIndex` references.
   - **Mock compilation** (mocks mode only) — esbuild compiles each scene's TSX into a JS function ready for Remotion's sandbox.
   - **Voice-over** — ElevenLabs TTS (`eleven_multilingual_v2`) synthesizes the concatenated script with the chosen voice + tone settings (stability/style/similarityBoost from `TONE_PRESETS`); duration probed via `music-metadata`.
   - **Music** (optional) — preset MP3, AI-generated via ElevenLabs Music (~30 s extra), or the user's uploaded MP3. Non-fatal: a music failure is recorded as `musicError` and the render proceeds without music.
   - **Render** — POST to the Railway video-service `/render-marketing-video` with the manifest; service runs Remotion → MP4 → uploads to Supabase Storage.
5. Backend bumps usage: `incrementUsage(teamId, 'marketing_video')`.
6. Backend flips the job to `completed` (or `failed` with the error message).
7. Frontend Realtime listener (`useJobRealtime`) fires; `MarketingVideoPanel` refetches the summary via direct Supabase read (`fetchMarketingVideo` in `db.ts`); video player + Download MP4 button appear in place of the ProgressLoader.

**Frontend UX**:
- The form is intentionally lean: brief (textarea), visual style (radio), voice-over toggle + voice/tone selectors, music dropdown + volume, a single Generate button. The script preview is **not** shown (it's not editable so it would only add noise). Pricing is hidden during the design-partner phase.
- During generation: a 4-step `ProgressLoader` (script → voice-over → music → render) covers the full 2-3 min pipeline. Visibility is driven by `ourJob?.status === 'running'` (not the local `working` flag, which flips back after the 202 returns in ~1 s).
- The bottom-right `JobTracker` card runs in parallel — the user can navigate away and the card surfaces completion globally.

**Cost** (real COGS): ~€0.60 per generation = Gemini Pro script (~€0.08) + ElevenLabs voice (~€0.30) + ElevenLabs music (~€0.20 if AI) + Railway render (~€0.05). Token weight = 600 (heaviest single op). See `TOKEN_COSTS` / `EURO_COSTS` / `OVERAGE_EUR` in `src/features/billing/billing.service.ts`.

## 12. Public Documentation Pages

**Trigger**: User toggles "Public" on a page
**Flow**:
1. Sets `doc_pages.is_public = true`
2. Page content accessible at `GET /api/docs/:projectId/:slug` (no auth required)
3. Project page list at `GET /api/docs/:projectId`

## 12b. Project Analytics (chat + doc views + on-demand recommendations)

**Trigger**: Owner opens Project → **Analytics** tab (period: 7d / 30d / 90d)

**Tracking (continuous, fire-and-forget)**:
1. Every user chat message is persisted and then immediately classified by a tiny Gemini call (`classifyAndStoreUserMessage`). It writes back `sentiment` / `frustration_flag` / `language` / `category` onto the row. All three chat routes (`chat.routes.ts`, `widget.routes.ts`, `public-docs.routes.ts`) use the same helper.
2. Every public-doc page switch — `PublicDocs.tsx` activePage effect — fires `POST /api/docs/:projectId/view` (rate-limited 120/min per IP+project) which inserts into `doc_page_views`. Deduped per tab via a ref.

**Dashboard read (`GET /api/projects/:id/analytics?period=30d`) — zero LLM calls**:
- SQL aggregates: sessions, messages, source breakdown, sentiment counts, top viewed pages (up to 5000 msg rows / 10k view rows).
- Pain points = `GROUP BY category` on user messages, sorted by frustrated+negative volume, with up to 3 example quotes per bucket.
- Frustration signals = 10 most recent user messages where `frustration_flag = true`.
- All under 50ms, no cold-start cache issues, no cost on dashboard open.

**On-demand recommendations (`POST /api/projects/:id/analytics/recommendations`) — explicit owner action**:
- Runs Gemini synthesis pass on the last 200 user messages with `ANALYTICS_SYSTEM_PROMPT` to produce `{ summary, items[] }`.
- 5-minute cooldown per `(project, period)` to prevent accidental re-spend.
- Returns 409 `NOT_ENOUGH_DATA` if fewer than 20 user messages in the period.

**Why this split**: the things SQL can compute (counts, categories, examples, sentiment aggregates) belong in SQL — they're always fresh and free. The thing Gemini is needed for — synthesising prioritised product-improvement recommendations across a sample — happens explicitly, when the owner asks.

**Cold-start**: until a message is classified (or in the 10s window before the fire-and-forget completes), it shows as uncategorised and doesn't appear in pain points. That's OK — it'll land on the next dashboard refresh.

## 13. Project URL Analysis

**Trigger**: User enters a URL when creating a project
**Flow**:
1. `POST /api/projects/:pid/analyze-url` with the base URL
2. Gemini analyzes the page to extract: product name, description, audience, features
3. Auto-fills project fields

## Cost Per Run

| Phase | Model | Approx Cost |
|---|---|---|
| Video analysis | Gemini 2.5 Flash | ~$0.05 |
| Doc generation | Gemini 2.5 Flash | ~$0.08 |
| Voice-over script | Gemini 2.5 Flash | ~$0.02 |
| Voice-over TTS | ElevenLabs | ~$0.05 |
| **Total per page (video-to-doc + voice-over)** | | **~$0.20** |
| Try Doc test (25 steps) | Claude Sonnet 4 via Stagehand | ~$0.09 |
| Try Doc analysis | Gemini 2.5 Flash | ~$0.03 |
| Marketing video script | Gemini 2.5 Pro (mocks) / Flash (screenshots) | ~$0.08 |
| Marketing video voice-over | ElevenLabs | ~$0.30 |
| Marketing video music (optional) | ElevenLabs Music | ~$0.20 |
| Marketing video render | Remotion on Railway | ~$0.05 |
| **Marketing video total** | | **~$0.60** |

Auto-generate structure: ~$0.03 (one-time per project)
Context enrichment: ~$0.001 per generation
