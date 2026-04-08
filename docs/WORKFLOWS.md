# Workflows

## Core User Journey

```
Login → Projects → Create Project → Generate Docs (Video or Auto-explore) → 
Edit Docs → Chat with Docs → Enable Widget → Embed on Client App
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
4. Query embedded with Gemini embedding model → pgvector cosine search → top 10 chunks
5. Gemini generates answer with project context (name, audience, features, knowledge base)
6. Response includes: answer, source pages (clickable), follow-up suggestions (clickable)
7. Step-by-step: for "how do I" questions, gives 2-3 steps then proposes to continue

## Embeddable Widget

**Setup**: Project Settings → Embed Widget → Generate API Key → Copy snippet
**Integration**:
```html
<script src="https://app.aidoc.com/widget.js"
  data-key="aidoc_xxx"
  data-user-name="{{USER_NAME}}"
  data-user-email="{{USER_EMAIL}}"
  data-user-plan="{{USER_PLAN}}"
></script>
```
**Runtime**:
1. Widget loads config from `GET /api/widget/:key/config` (project name + suggestions)
2. Auto-detects current URL (`window.location.href`) for page-aware suggestions
3. Messages sent to `POST /api/widget/:key/chat` (rate limited 30 req/min)
4. Same RAG pipeline as internal chat, with user context for personalization
5. Floating button (bottom-right) + popup panel, dark theme, mobile responsive

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
4. Claude Sonnet analyzes content → proposes 5-15 pages with hierarchy
5. Pages created in DB: top-level first, then children
6. Frontend refreshes sidebar tree

**AI call**: 1x Sonnet (structure proposal)

## 3. Page Exploration

**Trigger**: User clicks "Explore & Document" on a page
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

**AI calls**: ~25x Haiku (one per agent step)

## 4. Documentation Generation

**Trigger**: Automatically after exploration, or "Generate Documentation" button
**Flow**:
1. `POST /api/runs/:id/generate-doc`
2. Backend:
   a. Fetch run + steps + questions + project context + page siblings
   b. Resolve screenshot signed URLs from Supabase Storage
   c. Build rich prompt with step data, screenshots, cross-page context
   d. Call Claude Sonnet with `max_tokens: 16384`
   e. Parse response: markdown + `---JSON---` + self-assessment
   f. Save to `generated_docs` table
   g. Copy markdown to `doc_pages.content` (editable copy)
3. Frontend refreshes page → shows rendered markdown

**AI call**: 1x Sonnet (doc generation)

## 5. Cross-Page Awareness

**When**: During both exploration and doc generation
**What the AI receives**:
- `projectContext`: product description, who it's for, terminology
- `tableOfContents`: all sibling pages with status and slug
- `existingPageSummaries`: first 200 chars of each sibling's content
- `credentials`: test login credentials as Stagehand variables
- `customPrompt`: user's page-specific instructions

**Effect**: Claude can reference other pages (`See [Login Guide](/login)`) and avoid duplicating content.

## 5b. Context Learning (Auto-Enrichment)

**When**: After each documentation generation
**Flow**:
1. After doc gen, a lightweight Haiku call analyzes the generated markdown
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

**Cost**: ~$0.01 per enrichment (Haiku, small prompt)
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
- `[...]` menu on hover → Move up, Move down, Move to parent, Delete
- Move up/down: swap `sortOrder` with sibling
- Move to parent: update `parentId` via `PUT /api/projects/:pid/pages/:id`
- Delete: `DELETE /api/projects/:pid/pages/:id`

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

## Cost Per Run

| Phase | Model | Approx Cost |
|---|---|---|
| Exploration (25 steps) | Haiku 4.5 | ~$0.09 |
| Doc generation | Sonnet 4 | ~$0.08 |
| **Total per page** | | **~$0.17** |

Auto-generate structure: ~$0.03 (one-time per project)
