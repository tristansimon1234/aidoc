# AI Prompts & Models

## Models Used

| Purpose | Model | Cost | Where |
|---|---|---|---|
| Documentation generation | Gemini 2.5 Flash | ~$0.003/doc | `documentation.generator.ts` via `generateText()` |
| Video analysis | Gemini 2.5 Flash | ~$0.01/video | `gemini.client.ts` → `analyzeVideoWithGemini()` |
| Auto-generate structure | Gemini 2.5 Flash | ~$0.002/call | `page.service.ts` via `generateText()` |
| Context enrichment | Gemini 2.5 Flash | ~$0.001/call | `run.service.ts` via `generateText()` |
| Chat (RAG) | Gemini 2.5 Flash | ~$0.001/msg | `chat.service.ts` via `generateText()` |
| Chat suggestions | Gemini 2.5 Flash | ~$0.001/call | `chat.service.ts` → `getSuggestions()` |
| Embeddings | Gemini embedding (auto-discovered) | ~$0.0001/chunk | `gemini.client.ts` → `embedTexts()` via REST API |
| Browser exploration (beta) | Claude Sonnet 4 via Stagehand | ~$0.01/step | `exploration.service.ts` via `STAGEHAND_MODEL` |
| Try Doc analysis | Gemini 2.5 Flash | ~$0.005/report | `prompt.builder.ts` → `buildTryDocAnalysisPrompt()` |
| Smart RAG filter | Heuristic (no AI) | $0 | `chat.service.ts` → `needsDocSearch()` |

## Exploration Agent Instruction

**Location**: `src/features/exploration/exploration.service.ts` (inline, not in prompt.builder)

**Context injected**:
- Feature name, goal, start URL
- Previous steps (grouped by URL with action counts) — for resume
- Project context — structured: audience, workflow, quirks (formatted as markdown)
- Table of contents (sibling pages with status)
- Credentials (as Stagehand `%variable%` syntax)
- Page briefing — objective, domain knowledge, typed resources (replaces custom prompt)
- Custom prompt — legacy fallback if no briefing exists

**Key instructions to the agent**:
- "Be systematic: go through navigation items one by one"
- "If login page without credentials → call done IMMEDIATELY"
- "If action fails twice → move on, don't retry"
- "Don't navigate in circles"

**maxSteps**: 50

## Documentation Generation Prompt

**Location**: `src/shared/ai/prompt.builder.ts` → `buildDocumentationPrompt()`

**Input data**:
- Steps with importance tagging ([KEY] vs [supporting])
- Screenshots inline at each step (not listed separately)
- Run status (completed/blocked/failed) + step counts
- Project context, table of contents, page content summaries
- Blockers encountered during exploration

**Key instructions**:
- "Group steps into logical user flows (2-5 flows)"
- "Skip exploratory dead-ends, focus on happy path"
- "Place screenshots at the step they belong to"
- "Write in the SAME LANGUAGE as the website"
- "Be brutally honest in self-assessment"

**Output format**: Markdown + `---JSON---` separator + self-assessment JSON

**max_tokens**: 16384

## Self-Assessment JSON Schema

```typescript
{
  featureName: string
  totalSteps: number
  keyPages: string[]
  userActions: string[]
  screenshots: number
  selfAssessment: {
    overallCompleteness: number  // 0-100
    stepAssessments: { stepIndex, confidence, note }[]
    gaps: { area, reason, severity: 'major'|'minor' }[]
    nextSteps: { suggestion, reason, priority: 'high'|'medium'|'low' }[]
    structuralSuggestions?: { type: 'move'|'merge'|'split'|'rename'|'new', targetSlug, details, suggestedTitle }[]
  }
}
```

## Auto-Generate Structure Prompt

**Location**: `src/features/page/page.service.ts` → `autoGenerateStructure()`

**Input**: Site text content (first 5000 chars from `session.extract()`)

**Output**: JSON array of 5-15 pages with hierarchy:
```json
{
  "pages": [
    { "title": "Getting Started", "slug": "getting-started", "startUrl": "...", "goal": "...", "parentSlug": null, "sortOrder": 0 }
  ]
}
```

## Context Enrichment Prompt

**Location**: `src/shared/ai/prompt.builder.ts` → `buildContextEnrichmentPrompt()`

**When**: Called after each documentation generation
**Model**: Gemini 2.5 Flash — cheap, ~$0.001 per call

**Input**:
- `existingContext`: current `projects.discovered_context` (or null for first time)
- `newMarkdown`: the generated documentation
- `featureName`: the page being documented

**Output**: Structured JSON merged with existing knowledge:
```json
{
  "lastUpdated": "ISO timestamp",
  "siteStructure": ["/ (homepage)", "/pricing", "/admin"],
  "navigation": ["Home", "Pricing", "Settings"],
  "terminology": {"term": "definition"},
  "features": ["User auth", "Dashboard"],
  "summary": "2-3 sentence product summary"
}
```

**Key instruction**: "Merge with existing knowledge — don't replace it."

**Effect**: Each exploration enriches the project context. Future explorations are more informed about the product.

## Try Doc Analysis Prompt

After Stagehand exploration, Gemini analyzes the raw step data against the original documentation.

**Location**: `src/shared/ai/prompt.builder.ts` → `TRY_DOC_ANALYSIS_SYSTEM_PROMPT` + `buildTryDocAnalysisPrompt()`

**System prompt** instructs Gemini to judge as a naive user:
- "Click Create" but button says "New" → DOC issue
- Product errors out → PRODUCT issue
- Doc assumes knowledge never explained → implicit assumption

**Output**: Structured JSON with 7 sections:
1. Summary (pass/fail/ambiguous counts, overall verdict)
2. Step-by-step results (instruction vs actual, issue type)
3. Failures & root causes (doc vs product, severity, suggestion)
4. Documentation issues (clarity score 1-10, missing/ambiguous/implicit)
5. UX insights (friction, missing feedback, unnecessary steps)
6. Recommendations (fix-doc, fix-product, improve-ux with priority)
7. Global scores (doc quality, test pass rate, UX clarity — each 1-10)

## Message Classifier Prompt (write-time, per message)

Tiny Gemini call made fire-and-forget right after each user chat message is stored. Fills the `sentiment` / `frustration_flag` / `language` columns on `chat_messages` so the Analytics UI can filter and the backend can aggregate trendlines without re-running the heavy insights pass.

**Location**: `src/shared/ai/prompt.builder.ts` → `MESSAGE_CLASSIFIER_SYSTEM_PROMPT` + `buildMessageClassifierPrompt()`

**Inputs**: single message content (trimmed to 500 chars).

**System prompt enforces**:
- Return minified JSON with exactly 3 fields (`sentiment`, `frustrated`, `language`) — no prose, no markdown.
- Neutral is the default. Don't over-flag negativity on plain questions.
- `frustrated=true` requires real signals (complaints, repeated tries, explicit anger). "How do I X?" is NEUTRAL.

**Output**: `{"sentiment": "positive"|"neutral"|"negative", "frustrated": boolean, "language": "fr"|"en"|...}`

**Cost** (Gemini 2.5 Flash, ~150 in / ~20 out tokens per call): ≈ €0.00015 / message. A 10 k-message month runs under €2; can switch to Flash-Lite or batch 10-20 msgs/call to divide by 5-10× if volume grows.

## Analytics Insights Prompt

Feeds Gemini the last 200 user-role chat messages + top viewed public-doc pages for a project, returns a structured insights report shown on the Analytics tab.

**Location**: `src/shared/ai/prompt.builder.ts` → `ANALYTICS_SYSTEM_PROMPT` + `buildAnalyticsPrompt()`

**System prompt** enforces:
- Base everything on the actual messages provided — no invented topics.
- Detect the dominant language in the sample and write EVERY field in that language (French → French, English → English).
- `frustrationSignals` only when wording actually conveys irritation ("je comprends rien", "nul", "broken") — empty array otherwise, no hallucinated signals.
- `contentGaps` = questions asked multiple times not adequately covered. Set `suggestedPage` to the page title that *should* cover it (may not exist yet).
- `recommendations` must tie to observed evidence. `type='content'` (edit/create doc page) · `'product'` (change the product) · `'ux'` (fix flow).

**Inputs** (from `analytics.service.ts` → `generateInsights`):
- `productName`, `productDescription`
- `sessionCount`, `messageCount` (period aggregates)
- `sampleUserMessages[]` — last 200 user messages, trimmed to 400 chars
- `topPages[]` — top 10 viewed public-doc pages
- `allPageTitles[]` — full doc table of contents

**Output**: JSON validated by `AiInsightsSchema`:
```ts
{
  overallSentiment: { score: 'positive'|'neutral'|'negative'|'mixed', summary: string }
  painPoints: [{ topic, frequency, severity: 'high'|'medium'|'low', examples: string[] }]
  frustrationSignals: [{ excerpt, reason, severity }]
  contentGaps: [{ question, askedCount, suggestedPage: string | null }]
  recommendations: [{ type, title, description, priority }]
}
```

Cached 10 min per `(projectId, period)` in memory. JSON-repair fallback on parse failure (strip fences → brace-slice → close open braces/quotes).

## Prompt Improvement Guidelines

When modifying prompts:
1. All doc generation prompts stay in `prompt.builder.ts`
2. Test with a real site before deploying — quality is subjective
3. Keep the `---JSON---` separator format
4. Zod validates all JSON output — update schemas when changing JSON structure
5. Self-assessment honesty > inflated completeness scores
