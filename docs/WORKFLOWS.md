# Workflows

## Core User Journey

```
Login → Projects → Create Project → Record/Upload Video → AI Generates Docs →
Edit Docs → Generate Voice-over → Chat with Docs →
Enable Widget / MCP → Embed on Client App / Attach to Claude
```

## Video-to-Doc Flow (primary)

**Trigger**: "Upload a screen recording" in the Generate tab.
**Flow**:
1. Frontend creates a run (`POST /api/runs`).
2. Video uploaded directly to Supabase Storage via a signed URL (`POST /runs/:id/signed-upload-url`).
3. Backend calls `POST /runs/:id/analyze-video` with `generateDoc: true`, which:
   - Creates a `jobs` row (`type: 'doc-gen'`, `status: 'running'`). Unique-index collision returns 409 `JOB_ALREADY_RUNNING`.
   - Converts the video to MP4 via the FFmpeg microservice (`/convert`) if needed.
   - Downloads and sends it to Gemini 2.5 Flash (`analyzeVideoWithGemini`).
   - Gemini returns structured steps: `timestamp, screenDescription, userAction, narration`.
   - Extracts JPEG frames at those timestamps via the microservice (`/extract-frames`, falls back to client-side Canvas).
   - Probes duration (`/probe`) and corrects Gemini's MM:SS concatenation errors (`correctTimestamps`).
   - Saves steps with screenshot paths; stores `videoPath`, `stepTimestamps[]`, and `agentMessage` in `runs.summary_json`.
   - Calls `generateDoc()` → markdown auto-copied to `doc_pages.content`, page marked `published`.
   - Re-indexes page embeddings (fire-and-forget).
   - Enriches `projects.discovered_context` (fire-and-forget, with JSON repair).
   - Updates the job to `completed` (or `failed` with an error message).
4. Frontend tracks progress via Supabase Realtime on the `jobs` table (`useJobRealtime` / `JobTracker`).

## Chat with Documentation (RAG)

**Trigger**: User clicks 💬 in the project sidebar.
**Flow**:
1. `POST /chat/index` — checks if embeddings exist, indexes if not (skipped when `cached: true`).
2. `GET /chat/suggestions` — Gemini generates 6 project-specific questions (in-memory cache, 1 h TTL).
3. User sends a message → `POST /chat`.
4. Smart RAG: `needsDocSearch()` heuristic skips embedding search for greetings / small talk / continuation messages.
5. Query embedded → pgvector cosine search (`match_doc_chunks`) → top 10 chunks.
6. Gemini generates the answer with project context (name, audience, features, discovered knowledge).
7. Response: `{answer, sources[], followUps[]}`. For "how do I…" questions, Gemini gives 2-3 steps then proposes to continue.

## Embeddable Widget

**Setup**: Project Settings → Embed Widget → Generate API Key → copy snippet.

```html
<script src="https://app.aidoc.com/widget.js"
  data-key="aidoc_xxx"
  data-user-name="{{USER_NAME}}"
  data-user-email="{{USER_EMAIL}}"
  data-user-plan="{{USER_PLAN}}"
></script>
```

**Runtime**:
1. Widget loads config from `GET /api/widget/:key/config` (project name + cached suggestions + design). Edge-cached `s-maxage=300, stale-while-revalidate=600` plus an inline `data-cfg` attribute for zero-flash theming.
2. Auto-detects current URL (`window.location.href`) for page-aware suggestions.
3. Messages → `POST /api/widget/:key/chat` (rate-limited 30 req/min).
4. AI-guided walkthrough → `POST /api/widget/:key/walkthrough` (rate-limited 10 req/min, requires `walkthrough_enabled`).
5. Suggestions cached in-memory 1 h (background refresh when missing).
6. Floating button + popup panel, dark theme, mobile responsive. Greeting + position configurable via `design`.

## MCP Server (for external AI assistants)

**Setup**: Project Settings → MCP → Generate MCP API Key.
**Endpoint**: `POST https://app.aidoc.com/api/mcp/:mcpApiKey` (JSON-RPC 2.0).
**Auth**: separate `mcp_api_key` (distinct from widget).
**Rate limit**: 30 req/min per key.
**Methods**:
- `initialize` → returns `{protocolVersion, capabilities.tools, serverInfo: aidoc-<project>}`.
- `tools/list` → `search_documentation(query)` + `list_pages()`.
- `tools/call` → executes the tool and returns `content[]`.
- `notifications/initialized`, `ping` → no-op acks.

`search_documentation` embeds the query, runs pgvector cosine search (top 8, threshold 0.25), and returns concatenated chunks with page headers. `list_pages` returns titles/slugs/preview for pages with content.

## 1. Project Creation

1. User fills: name, base URL, description, product context, test credentials.
2. Optional `POST /api/projects/analyze-url` pre-fills name / description / audience / workflow / design using Gemini.
3. `POST /api/projects` → creates the project with `user_id` (RLS isolation).
4. Redirect to project detail.

## 2. Auto-generate Documentation Structure

Not currently exposed as an endpoint. Pages are created manually via `POST /api/projects/:pid/pages` or from the sidebar "New page" action.

## 3. Try Doc Exploration

**Trigger**: User clicks "Run Test" on a page (Try Doc tab).
**Flow**:
1. Optional preflight: `POST /pages/:id/preflight` → Gemini checks the doc for missing URLs, credentials, files, prerequisites (`{ready, testPlan, estimatedSteps, checks[]}`).
2. `POST /api/runs` with `feature_name: '[Test] …'` (naive-user mode).
3. `POST /api/runs/:id/explore` → SSE stream.
4. Backend:
   - Launches Stagehand (Browserbase cloud).
   - Navigates to `startUrl`.
   - Injects project context + page briefing (with file resources downloaded inline) + credentials as Stagehand variables.
   - Each tool call → `onStepFinish` saves the step + emits SSE (`live`, `status`, `step`, `done` / `blocked` / `error`).
   - Browser always closed in `finally` (avoids Browserbase billing).
5. `POST /runs/:id/analyze-try` → Gemini generates the 7-section report, attaches public screenshot URLs, saves to `runs.summary_json.tryDocReport`.
6. Test tab renders the persisted report with a verdict badge.

## 4. Documentation Generation

**Trigger**: Automatic after video analysis, or `POST /api/runs/:id/generate-doc`.
**Flow**:
1. Fetch run + steps + questions + project context + page siblings (`getProjectAwareness`).
2. Resolve screenshot signed URLs from Supabase Storage.
3. Call Gemini 2.5 Flash with `max_tokens: 16384`.
4. Parse: markdown + `---JSON---` + self-assessment.
5. Save to `generated_docs`, copy markdown to `doc_pages.content`.
6. Re-index embeddings. Enrich `discovered_context`. Mark run `completed`.

`?async=1` → responds `202 {runId, status: 'running'}` and runs the generation in the background. The frontend tracks completion via Supabase Realtime on `runs.status`.

## 5. Cross-Page Awareness

During both exploration and doc generation, the AI receives:
- `projectContext`: user-provided + AI-learned (features, navigation, terminology, site structure, summary).
- `tableOfContents`: sibling pages with status + slug.
- `existingPageSummaries`: first 200 chars of each sibling's content.
- `credentials`: test logins as Stagehand `%variable%`.
- `customPrompt` + `briefing`: page-specific instructions (briefing supersedes customPrompt when present; file-typed resources are downloaded from the `briefing-files` bucket and attached to the Gemini request).

Effect: Gemini can reference other pages (`See [Login](/login)`) and avoid duplication.

## 5b. Context Learning (auto-enrichment)

After every doc generation (fire-and-forget):
1. `buildContextEnrichmentPrompt()` produces a merge-not-replace instruction.
2. Gemini returns JSON: `{lastUpdated, siteStructure[], navigation[], terminology{}, features[], summary}`.
3. Response is repaired if truncated (removes trailing incomplete key / closes open braces) and validated by `DiscoveredContextSchema` before save.

## 6. Resume Exploration

**Trigger**: User clicks "Continue Exploration" on a blocked/failed run (Try Doc).
**Flow**:
1. Reuses the run ID.
2. Backend groups existing steps by URL and injects a "Pages Already Explored" section into the agent instruction.
3. Fresh Stagehand session (old one is closed).
4. Answered blocker questions are merged back into the context.

## 7. Manual Editing

`PUT /api/projects/:pid/pages/:id { content }` updates the editable markdown. Content is the source of truth for display. Editing auto-re-indexes embeddings (fire-and-forget).

## 8. Page Organization

- Drag-and-drop reorder in the sidebar, optimistic UI, synced via `PUT /pages/reorder`.
- `[...]` menu: Move up / down, Move to parent, Delete, Toggle public.
- Delete: `DELETE /api/projects/:pid/pages/:id`.
- Child page links shown at the bottom of the page (Notion-style).

## 9. Self-Assessment & Suggestions

After doc generation the JSON includes:
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

Frontend renders: completeness bar, gaps list with severity badges, "Suggested Next Pages" with [Create Page] buttons, structural suggestions (merge / split / move / rename / new).

## 10. Try Doc (Documentation Testing)

1. User opens the Test tab on a page → optionally runs Preflight → clicks "Run Test".
2. System creates a run with `[Test]` prefix and naive-user prompt.
3. Stagehand agent opens the app in Browserbase; SSE streams live steps.
4. Screenshots are disabled in Try Doc mode to reduce latency.
5. Gemini analyzes the steps vs the documentation → 7-section report stored in `runs.summary_json.tryDocReport`.
6. Test tab shows the persisted report with pass/fail/partial verdict badges.

## 11. Voice-over Narration

**Trigger**: "Generate voice-over" in the Video tab.
**Flow**:
1. `POST /runs/:id/generate-voiceover` with `{voiceId, language, tone, videoDuration}`. Creates a `jobs` row (`type: 'voiceover'`).
2. Backend merges `stepTimestamps` into sections (`< 8 s` gap → merged, `< 5 s` from end → dropped, intro auto-added if first action is `> 3 s` in).
3. Downloads video from Supabase Storage; Gemini watches the video and writes an ElevenLabs-v3-formatted script with `[SECTION N]` markers and per-section word budgets (~2 words/sec, five tone presets).
4. ElevenLabs (`eleven_multilingual_v2`) synthesizes each section as MP3.
5. FFmpeg microservice (`/concat-audio`) concatenates segments with silence padding aligned to `targetStartTime`, producing a single `voiceover.mp3`.
6. Stored in `runs.summary_json.voiceover` (`{audioPath, audioUrl, segments[]}`).
7. Job marked `completed`.

**Editing**:
- Click segment text → edit → `POST /runs/:id/regenerate-segment` re-synthesizes that segment, then re-concatenates all segments into a new `voiceover.mp3`.
- Drag timeline handles → `PUT /runs/:id/voiceover-segments` adjusts timing (no re-synthesis).
- Regenerate full voice-over has a confirmation dialog when one already exists.

## 12. Public Documentation Pages

**Trigger**: Toggle "Public" on a page → `is_public = true`.
**Endpoint**: `GET /api/docs/:projectId` (public, no auth) lists all public pages for the project, including per-page video/voiceover URLs when `briefing.showVideoOnPublic === true`. Rendered as `/docs/:projectId` on the frontend (`PublicDocs` page). Individual pages are also shareable via the `SharePage` route.

## 13. Project URL Analysis

`POST /api/projects/analyze-url { url }` → Gemini reads the URL's HTML/meta and returns `{name, description, audience, workflow, design{accentColor, bgColor, textColor, font}}`. Always falls back to safe defaults (`#2563EB` / `#FFFFFF` / `#1A1A1A` / `Inter`).

## 14. Video Trimming

`POST /runs/:id/trim-video { startTime, endTime }` → FFmpeg microservice trims the video, saves `-trimmed.mp4`, and updates `runs.summary_json` with the new `videoPath`, adjusted `stepTimestamps`, and `trimApplied`.

## 15. Usage / Cost

`GET /api/projects/:id/usage` returns aggregated token usage and an estimated cost split between documentation generation (Gemini ~$0.35/M avg) and Try Doc testing (Stagehand / Claude ~$9/M avg).

## 16. Chrome Extension (optional)

`extension/` is a Manifest-V3 extension that advertises itself via `window.__AIDOC_EXTENSION__` and relays DOM-capture events (`AIDOC_START_DOM_CAPTURE` / `AIDOC_STOP_DOM_CAPTURE`) between the AiDoc web app and the extension's service worker. Intended for richer recordings in future; not required for the core flow.

## 17. Evals

`npm run eval` (Vitest) executes `evals/eval.test.ts` against fixtures in `evals/fixtures/` and grades the output using `scoreHeuristics` and `scoreLlmJudge` against the `evals/criteria/*.json` rubric.

## Cost Reference

| Phase | Model | Approx Cost |
|---|---|---|
| Video analysis | Gemini 2.5 Flash | ~$0.05 |
| Doc generation | Gemini 2.5 Flash | ~$0.08 |
| Voice-over script (video-aware) | Gemini 2.5 Flash | ~$0.02 |
| Voice-over TTS | ElevenLabs | ~$0.05 |
| Try Doc test (~25 steps) | Claude Sonnet 4 via Stagehand | ~$0.09 |
| Try Doc analysis | Gemini 2.5 Flash | ~$0.03 |
| Context enrichment | Gemini 2.5 Flash | ~$0.001 |
| URL analysis | Gemini 2.5 Flash | ~$0.001 |
| Preflight | Gemini 2.5 Flash | ~$0.002 |
| Walkthrough | Gemini 2.5 Flash | ~$0.002 per step |
