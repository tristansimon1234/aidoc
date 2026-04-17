# AI Prompts & Models

## Models Used

| Purpose | Model | Where |
|---|---|---|
| Documentation generation | Gemini 2.5 Flash | `documentation.generator.ts` → `generateText()` |
| Video analysis (steps + narration) | Gemini 2.5 Flash | `gemini.client.ts` → `analyzeVideoWithGemini()` |
| Narration script (watches the video) | Gemini 2.5 Flash | `gemini.client.ts` → `generateNarrationFromVideo()` |
| Voice-over TTS | ElevenLabs `eleven_multilingual_v2` | `elevenlabs.client.ts` → `synthesizeSpeech()` |
| URL analysis (auto-fill project) | Gemini 2.5 Flash | `project.routes.ts` → `/projects/analyze-url` |
| Context enrichment (learns from docs) | Gemini 2.5 Flash | `run.service.ts` after doc gen, uses `buildContextEnrichmentPrompt()` |
| Chat (RAG) | Gemini 2.5 Flash | `chat.service.ts` → `generateText()` |
| Chat suggestions | Gemini 2.5 Flash | `chat.service.ts` → `getSuggestions()` |
| Walkthrough (AI-guided DOM steps) | Gemini 2.5 Flash | `prompt.builder.ts` → `WALKTHROUGH_SYSTEM_PROMPT` + `buildWalkthroughPrompt()` |
| Preflight (Try Doc readiness) | Gemini 2.5 Flash | `prompt.builder.ts` → `PREFLIGHT_SYSTEM_PROMPT` + `buildPreflightAnalysisPrompt()` |
| Try Doc analysis | Gemini 2.5 Flash | `prompt.builder.ts` → `TRY_DOC_ANALYSIS_SYSTEM_PROMPT` + `buildTryDocAnalysisPrompt()` |
| Embeddings (768-dim) | Gemini embedding (auto-discovered via ListModels) | `gemini.client.ts` → `embedTexts()` / `embedText()` |
| Try Doc exploration agent | Claude Sonnet 4 via Stagehand (`STAGEHAND_MODEL`) | `exploration.service.ts` (inline instruction) |
| Smart RAG filter | Heuristic (no AI) | `chat.service.ts` → `needsDocSearch()` |

Stagehand model is set via the `STAGEHAND_MODEL` constant (`anthropic/claude-sonnet-4-20250514`) and requires `ANTHROPIC_API_KEY`.

## Exploration Agent Instruction (Try Doc)

**Location**: `src/features/exploration/exploration.service.ts` (inline, not in `prompt.builder.ts` — known tech debt).

**Context injected**:
- Feature name, goal, start URL
- Previous steps (grouped by URL with action counts) — for resume
- Project context — `{audience, workflow, quirks}` formatted as markdown
- Discovered context summary (features, navigation, terminology, site structure)
- Table of contents (sibling pages with status)
- Credentials (as Stagehand `%variable%` syntax)
- Page briefing — objective, domain knowledge, typed resources (merged with project resources, file resources downloaded inline)
- Custom prompt — legacy fallback if no briefing

**Try Doc mode**: When `feature_name` starts with `[Test]`, screenshots are skipped and the agent is instructed to follow the doc verbatim as a naive user.

**maxSteps**: 50

## Documentation Generation Prompt

**Location**: `src/shared/ai/prompt.builder.ts` → `buildDocumentationPrompt()` + `VIDEO_DOC_SYSTEM_PROMPT`.

**Input data**:
- Steps with importance tagging ([KEY] vs [supporting])
- Screenshots inline at each step (signed Supabase URLs)
- Run status (completed / blocked / failed) + step counts
- Project context, table of contents, existing page content summaries (200 chars each)
- Blockers encountered during exploration

**Output format**: Markdown + `---JSON---` separator + self-assessment JSON.
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
    overallCompleteness: number                                   // 0-100
    stepAssessments: { stepIndex, confidence, note }[]
    gaps: { area, reason, severity: 'major'|'minor' }[]
    nextSteps: { suggestion, reason, priority: 'high'|'medium'|'low' }[]
    structuralSuggestions?: { type: 'move'|'merge'|'split'|'rename'|'new', targetSlug, details, suggestedTitle }[]
  }
}
```

## Context Enrichment Prompt

**Location**: `src/shared/ai/prompt.builder.ts` → `buildContextEnrichmentPrompt()`.
**When**: Fire-and-forget after each documentation generation (`run.service.ts` → `generateDoc()`).

**Input**: `existingContext` (current `projects.discovered_context`), `newMarkdown`, `featureName`.

**Output**: Structured JSON merged with existing knowledge:
```json
{
  "lastUpdated": "ISO timestamp",
  "siteStructure": ["/", "/pricing", "/admin"],
  "navigation": ["Home", "Pricing", "Settings"],
  "terminology": {"term": "definition"},
  "features": ["User auth", "Dashboard"],
  "summary": "2-3 sentence product summary"
}
```

Key instruction: "Merge with existing knowledge — don't replace it." Includes fallback JSON repair logic when output is truncated.

## URL Analysis Prompt

**Location**: inline in `src/features/project/project.routes.ts` → `POST /api/projects/analyze-url`.

Fetches the HTML, extracts `<title>`, `meta[name=description]`, `og:description`, `meta[name=theme-color]`, the first Google Font, and the first ~2000 chars of text, then asks Gemini for a JSON with `{name, description, audience, workflow, design{accentColor, bgColor, textColor, font}}`. Always falls back to safe defaults (`#2563EB`, `#FFFFFF`, `#1A1A1A`, `Inter`).

## Try Doc Analysis Prompt

**Location**: `src/shared/ai/prompt.builder.ts` → `TRY_DOC_ANALYSIS_SYSTEM_PROMPT` + `buildTryDocAnalysisPrompt()`.

After Stagehand exploration, Gemini compares raw step data to the original documentation as a naive user would.

**System prompt** teaches the distinction:
- "Click Create" but button says "New" → DOC issue.
- Product errors out → PRODUCT issue.
- Doc assumes knowledge that is never explained → implicit assumption.

**Output**: Structured JSON with 7 sections (validated by `TryDocReportSchema`):
1. Summary (pass/fail/ambiguous counts, overall verdict).
2. Step-by-step results (instruction vs actual, issue type, screenshot path).
3. Failures & root causes (doc vs product, severity, suggestion).
4. Documentation issues (clarity score 1-10, missing sections, ambiguous instructions, implicit assumptions).
5. UX insights (friction, missing feedback, unnecessary steps).
6. Recommendations (fix-doc / fix-product / improve-ux with priority).
7. Global scores (doc quality, test pass rate, UX clarity — each 1-10).

Includes JSON repair logic for truncated responses. Screenshot paths are resolved to public URLs after parsing.

## Preflight Prompt

**Location**: `src/shared/ai/prompt.builder.ts` → `PREFLIGHT_SYSTEM_PROMPT` + `buildPreflightAnalysisPrompt()`.
**Endpoint**: `POST /api/projects/:pid/pages/:id/preflight`.

Analyzes a documentation page and identifies only the external resources (URLs, credentials, files, prerequisites) that must exist before a Try Doc run can succeed. Returns `{ready, testPlan, estimatedSteps, checks[]}` where each check is `{category, label, status: ready|missing|warning, detail, resolution}`.

## Walkthrough Prompt (AI-guided widget)

**Location**: `src/shared/ai/prompt.builder.ts` → `WALKTHROUGH_SYSTEM_PROMPT` + `buildWalkthroughPrompt()`.
**Endpoint**: `POST /api/widget/:key/walkthrough`.

Maps the user's current DOM snapshot to a documentation step and returns the next action as JSON. Rate-limited to 10 requests/min per widget key. Requires `project.walkthrough_enabled`.

## Narration Prompt (voice-over)

**Location**: inline in `src/features/run/run.routes.ts` → `POST /runs/:id/generate-voiceover`.

Gemini watches the (downloaded) video and writes an ElevenLabs-v3-formatted script broken into `[SECTION N]` markers with per-section word budgets (~2 words/sec). Tone presets: `friendly | professional | energetic | calm | playful`. Falls back to text-only generation when the video cannot be downloaded.

## Prompt Improvement Guidelines

1. All doc-gen/analysis prompts stay in `prompt.builder.ts` (narration + URL analysis are the two inline exceptions because they mix heavy runtime data).
2. Test with a real site before deploying — quality is subjective.
3. Keep the `---JSON---` separator format in doc-gen output.
4. Zod validates every JSON output — update schemas whenever JSON structure changes.
5. Self-assessment honesty > inflated completeness scores.
