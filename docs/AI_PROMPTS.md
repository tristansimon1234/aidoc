# AI Prompts & Models

## Models Used

| Purpose | Model | Cost | Where |
|---|---|---|---|
| Browser exploration (Stagehand) | `claude-sonnet-4-20250514` | ~$0.01/step | `playwright.client.ts`, `exploration.service.ts` via `STAGEHAND_MODEL` |
| Documentation generation | `claude-sonnet-4-20250514` | ~$0.08/doc | `documentation.generator.ts` via `CLAUDE_MODEL` |
| Auto-generate structure | `claude-sonnet-4-20250514` | ~$0.03/call | `page.service.ts` via direct API |

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
**Model**: Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) — cheap, ~$0.01 per call

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

## Prompt Improvement Guidelines

When modifying prompts:
1. All doc generation prompts stay in `prompt.builder.ts`
2. Test with a real site before deploying — quality is subjective
3. Keep the `---JSON---` separator format
4. Zod validates all JSON output — update schemas when changing JSON structure
5. Self-assessment honesty > inflated completeness scores
