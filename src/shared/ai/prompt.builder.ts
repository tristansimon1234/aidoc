import type { StepSummary } from '../../features/exploration/exploration.types.js'
import type { DiscoveredContext } from '../../features/project/project.types.js'
import type { DomSnapshot } from '../../features/chat/walkthrough.types.js'

export function buildContextEnrichmentPrompt(
  existingContext: DiscoveredContext | null,
  newMarkdown: string,
  featureName: string,
): string {
  return `Analyze this documentation and extract structured knowledge about the product.

## Previously Known
${existingContext ? JSON.stringify(existingContext, null, 2) : 'Nothing yet — this is the first exploration.'}

## New Documentation for "${featureName}"
${newMarkdown.slice(0, 6000)}

## Task
Update the knowledge base with what you learned. Merge with existing knowledge — don't replace it.

Respond with JSON only:
{
  "lastUpdated": "${new Date().toISOString()}",
  "siteStructure": ["/ (homepage)", "/pricing", "/about", ...all known URLs],
  "navigation": ["Home", "Pricing", "About", ...all nav items found],
  "terminology": {"term": "definition", ...product-specific terms},
  "features": ["User authentication", "Pricing plans", ...all features discovered],
  "summary": "2-3 sentence summary of what is now known about this product"
}`
}

function formatStepsRich(steps: StepSummary[]): string {
  if (steps.length === 0) return 'No steps recorded.'

  // Tag step importance
  const importantTools = new Set(['act', 'goto', 'fillForm', 'done'])
  const supportTools = new Set(['scroll', 'screenshot', 'ariaTree', 'wait', 'keys'])

  return steps
    .map((s, i) => {
      const toolType = s.action.split(' ')[0]?.toLowerCase() ?? ''
      const isKey = importantTools.has(toolType) || !supportTools.has(toolType)

      let entry = `### Step ${i + 1} [${isKey ? 'KEY' : 'supporting'}]`
      entry += `\n- URL: ${s.url}`
      entry += `\n- Action: ${s.action}`
      // KEY steps get full observation, supporting steps get truncated
      if (s.observation) {
        entry += `\n- Agent reasoning: ${s.observation.slice(0, isKey ? 500 : 100)}`
      }
      // Use placeholder instead of raw URL — Gemini corrupts UUIDs when copying verbatim
      if (s.screenshotUrl && s.screenshotUrl.startsWith('http')) entry += `\n- Screenshot: ![Step ${i + 1}]({{SCREENSHOT_${i}}})`
      return entry
    })
    .join('\n\n')
}

/**
 * Build a map of screenshot placeholders to actual URLs.
 * Call after Gemini returns to replace {{SCREENSHOT_0}} etc. with real URLs.
 */
export function buildScreenshotMap(steps: StepSummary[]): Map<string, string> {
  const map = new Map<string, string>()
  steps.forEach((s, i) => {
    if (s.screenshotUrl && s.screenshotUrl.startsWith('http')) {
      map.set(`{{SCREENSHOT_${i}}}`, s.screenshotUrl)
    }
  })
  return map
}

/**
 * Replace screenshot placeholders in generated markdown with actual URLs.
 * Also appends any missing screenshots that Gemini failed to place.
 */
export function replaceScreenshotPlaceholders(markdown: string, screenshotMap: Map<string, string>): string {
  let result = markdown
  const missing: string[] = []
  for (const [placeholder, url] of screenshotMap) {
    if (result.includes(placeholder)) {
      result = result.replaceAll(placeholder, url)
    } else {
      missing.push(`![Screenshot](${url})`)
    }
  }
  // Append missed screenshots so no image is lost
  if (missing.length > 0) {
    result += '\n\n' + missing.join('\n\n')
  }
  return result
}

function countByImportance(steps: StepSummary[]): { key: number; supporting: number; withScreenshots: number } {
  const importantTools = new Set(['act', 'goto', 'fillForm', 'done'])
  let key = 0
  let supporting = 0
  let withScreenshots = 0

  for (const s of steps) {
    const toolType = s.action.split(' ')[0]?.toLowerCase() ?? ''
    if (importantTools.has(toolType)) key++
    else supporting++
    if (s.screenshotUrl) withScreenshots++
  }

  return { key, supporting, withScreenshots }
}

// Static system instructions — cached by Anthropic (90% cost reduction on repeat calls)
export const VIDEO_DOC_SYSTEM_PROMPT = `You are an expert product documentation writer. Your job is to transform screen recording analysis data into a clear, professional, user-friendly guide.

The steps below were extracted from a screen recording of a web application (not a live exploration). Each step describes what was visible on screen and what the user was doing. Some steps may include narration from the person recording.

Write a **user-facing product guide** — the kind of documentation you'd find in a help center. Follow the same structure as for live explorations: Introduction, Getting Started, Walkthrough (group into logical flows), Key Features, FAQ/Tips. Embed screenshots at relevant steps using their {{SCREENSHOT_N}} placeholders exactly as provided — e.g. ![caption]({{SCREENSHOT_0}}).

After the markdown, add "---JSON---" and the self-assessment JSON (same schema as live explorations).`

const DOC_SYSTEM_PROMPT = `You are an expert product documentation writer. Your job is to transform raw exploration data into a clear, professional, user-friendly guide.

Write a **user-facing product guide** — the kind of documentation you'd find in a help center or product wiki. NOT an internal SOP.

### Writing Style
- Write as if you're explaining to a smart colleague who's never used the product
- Use clear, direct language — no jargon, no filler
- Be specific: use the ACTUAL button names, labels, and text visible in the screenshots
- If something is unclear from the exploration data, say so honestly
- Write in the SAME LANGUAGE as the content found on the website

### Document Structure

**1. Introduction** (2-3 sentences)
What is this feature and who is it for?

**2. Getting Started**
How to access this feature, any prerequisites

**3. Walkthrough** (main section — this should be the longest)
Group the exploration steps into **logical user flows**. Don't list every single step linearly. Instead:
- Identify 2-5 user flows (e.g. "Creating an account", "Browsing the catalog", "Making a purchase")
- For each flow, write numbered steps with:
  - What the user sees on screen
  - What they should click/do
  - A screenshot if available (use the inline image syntax)
- **IMPORTANT**: Embed screenshots inline at the relevant step using: ![description](url)
- Skip exploratory dead-ends — focus on the happy path
- If a flow is incomplete (exploration stopped midway), say so

**4. Key Features**
Highlight 3-5 notable features discovered during exploration

**5. FAQ / Tips**
2-3 practical tips based on what was observed

Do NOT include "Known Gaps", "Suggested Next Steps", or any meta-commentary about the exploration process in the markdown. That information goes in the JSON self-assessment only. The markdown should read like polished, final documentation.

### Screenshot Rules (MANDATORY)
- EVERY walkthrough step MUST include its screenshot if one is available
- Place screenshots inline at the step — NOT grouped at the end
- Screenshots use placeholders like {{SCREENSHOT_0}}, {{SCREENSHOT_1}}, etc. — use them EXACTLY as provided: ![Descriptive caption]({{SCREENSHOT_N}})
- Do NOT modify, rewrite, or skip these placeholders — they will be replaced with real URLs automatically
- If a step has no screenshot placeholder, describe the screen in vivid visual detail
- In self-assessment, flag any key step missing a screenshot as a critical gap

### Self-Assessment JSON

After the markdown, add "---JSON---" then:
{
  "featureName": "string",
  "totalSteps": number,
  "keyPages": ["url1", "url2"],
  "userActions": ["action1", "action2"],
  "screenshots": number,
  "selfAssessment": {
    "overallCompleteness": <0-100>,
    "stepAssessments": [
      { "stepIndex": 1, "confidence": "high"|"medium"|"low", "note": "string or null" }
    ],
    "gaps": [
      { "area": "string", "reason": "string", "severity": "major"|"minor" }
    ],
    "nextSteps": [
      { "suggestion": "Page Title", "reason": "What this page would document", "priority": "high"|"medium"|"low" }
    ],
    "structuralSuggestions": [
      { "type": "move"|"merge"|"split"|"rename"|"new", "targetSlug": "slug", "details": "why", "suggestedTitle": "title" }
    ]
  }
}

Be brutally honest in the self-assessment. A 40% completeness with clear gaps is better than 90% that hides problems.

IMPORTANT: If the exploration shows that the agent could NOT access certain features (failed login, access denied, errors), do NOT document those features as if they worked. Instead:
- Only document what was actually successfully explored and seen
- If a section was blocked, briefly mention it needs separate documentation
- Do NOT pad the document with speculation about blocked features
- Keep the document focused and honest — short and accurate is better than long and fabricated`

export function getDocSystemPrompt(): string {
  return DOC_SYSTEM_PROMPT
}

export function buildDocumentationPrompt(context: {
  featureName: string
  goal: string
  startUrl: string
  steps: StepSummary[]
  questions?: { question: string; answer: string | null }[]
  projectContext?: string
  tableOfContents?: string
  existingPageSummaries?: { title: string; slug: string; contentPreview: string }[]
  runStatus?: string
}): string {
  const counts = countByImportance(context.steps)

  const projectBlock = context.projectContext
    ? `\n## Product Context\n${context.projectContext}\n`
    : ''

  const tocBlock = context.tableOfContents
    ? `\n## Other Pages in This Documentation\n${context.tableOfContents}\nWhen referencing content covered by other pages, use markdown links like [Page Title](/slug). Do NOT duplicate content.\n`
    : ''

  const pageSummariesBlock = context.existingPageSummaries && context.existingPageSummaries.length > 0
    ? `\n## Existing Page Content (summaries)\n${context.existingPageSummaries.map((p) => `- **${p.title}** (/${p.slug}): ${p.contentPreview}`).join('\n')}\n`
    : ''

  const blockersSection = context.questions && context.questions.length > 0
    ? `\n## Blockers Encountered During Exploration\n${context.questions.map((q) => `- Issue: ${q.question}${q.answer ? `\n  Resolution: ${q.answer}` : ' (unresolved)'}`).join('\n')}\n`
    : ''

  const statusBlock = `\n## Exploration Status
- Run status: ${context.runStatus ?? 'unknown'}
- Total steps: ${context.steps.length} (${counts.key} key actions, ${counts.supporting} supporting)
- Screenshots captured: ${counts.withScreenshots}
${context.runStatus === 'blocked' ? '- Exploration was INCOMPLETE — document what was found but clearly flag gaps' : ''}
${context.runStatus === 'failed' ? '- Exploration FAILED — generate best-effort doc from available data' : ''}
${counts.withScreenshots < counts.key / 2 ? `- WARNING: Only ${counts.withScreenshots} out of ${counts.key} key steps have screenshots. Compensate with detailed visual descriptions.` : ''}
`

  // Build explicit list of available screenshot placeholders
  const availablePlaceholders = context.steps
    .map((s, i) => s.screenshotUrl && s.screenshotUrl.startsWith('http') ? `{{SCREENSHOT_${i}}}` : null)
    .filter(Boolean)
  const screenshotListBlock = availablePlaceholders.length > 0
    ? `\n## Available Screenshots — YOU MUST USE ALL OF THESE\nPlaceholders: ${availablePlaceholders.join(', ')}\nEmbed each one inline at the relevant walkthrough step using: ![caption]({{SCREENSHOT_N}})\n`
    : ''

  return `## Product
Name: "${context.featureName}"
URL: ${context.startUrl}
Goal: "${context.goal}"
${projectBlock}${tocBlock}${pageSummariesBlock}${statusBlock}${screenshotListBlock}
## Exploration Data

Steps marked [KEY] are important user actions. Steps marked [supporting] are navigation/setup.

${formatStepsRich(context.steps)}
${blockersSection}`
}

// --- Try Doc Analysis ---

export const TRY_DOC_ANALYSIS_SYSTEM_PROMPT = `You are a documentation quality analyst. You receive the original documentation and step-by-step results from an AI agent that attempted to follow the documentation exactly as a naive user would.

Your job is to produce a structured JSON analysis report.

CRITICAL RULES:
- Judge from the perspective of a NAIVE USER who only has the documentation
- If the doc says "click Create" but the button is labeled "New" → that is a DOC issue (issueType: "doc")
- If the doc instructions are correct but the product errors out → that is a PRODUCT issue (issueType: "product")
- If a step requires knowledge not in the doc (e.g., "you need admin access") → that is an IMPLICIT ASSUMPTION
- If a step is vague or could be interpreted multiple ways → that is AMBIGUOUS
- Be honest, specific, and actionable. Vague observations are useless.
- Scores should be realistic (not inflated). A doc with multiple failures should NOT score 8/10.
- AUTHENTICATION IS IMPLICIT: SaaS documentation universally assumes the user is already logged in. Do NOT flag the absence of login instructions as a doc gap, implicit assumption, or failure. If the agent had to log in before starting, that is expected and should not affect scores.

Return ONLY valid JSON (no markdown fences, no extra text).`

export function buildTryDocAnalysisPrompt(
  pageContent: string,
  pageTitle: string,
  steps: { stepIndex: number; url: string | null; action: string | null; observation: string | null; status: string }[],
): string {
  const stepsText = steps.map((s) =>
    `Step ${s.stepIndex}: [${s.status}] ${s.action ?? 'unknown action'}\nURL: ${s.url ?? 'unknown'}\nObservation: ${s.observation ?? 'none'}`,
  ).join('\n\n---\n\n')

  return `## Documentation being tested: "${pageTitle}"

${pageContent}

---

## Exploration results (what the AI agent did when following the doc):

${stepsText}

---

## Generate the analysis report as JSON with this exact structure:

{
  "summary": { "totalSteps": number, "passed": number, "failed": number, "ambiguous": number, "overallVerdict": "pass"|"fail"|"partial" },
  "steps": [{ "stepIndex": number, "instruction": "what the doc said", "action": "what agent did", "pageUrl": string|null, "status": "pass"|"fail"|"ambiguous", "issueType": "doc"|"product"|null, "detail": "explanation", "screenshotPath": null }],
  "failures": [{ "stepIndex": number, "issueType": "doc"|"product", "title": "short title", "description": "what went wrong", "severity": "critical"|"major"|"minor", "suggestion": "how to fix" }],
  "docIssues": { "clarityScore": 1-10, "missingSections": ["..."], "ambiguousInstructions": ["..."], "implicitAssumptions": ["..."] },
  "uxInsights": [{ "category": "friction"|"missing-feedback"|"unnecessary-step"|"doc-behavior-mismatch"|"implicit-assumption", "description": "...", "stepIndex": number|null, "severity": "high"|"medium"|"low" }],
  "recommendations": [{ "type": "fix-doc"|"fix-product"|"improve-ux", "title": "short action", "description": "details", "priority": "high"|"medium"|"low" }],
  "scores": { "docQuality": 1-10, "testPassRate": 1-10, "uxClarity": 1-10 }
}`
}

// --- Pre-flight Verification ---

export const PREFLIGHT_SYSTEM_PROMPT = `You are a test readiness analyst. Given a documentation page, identify ONLY the external resources that must be provided BEFORE the test can run.

The test agent is a browser automation tool. It can navigate, click, type, scroll, and upload files on its own — those are NOT requirements.

IMPORTANT: A "requirement" is something the test agent CANNOT do by itself. It is an EXTERNAL resource that must be prepared in advance.

Requirements are ONLY:
- A file that must be uploaded (PDF, video, image, spreadsheet, etc.)
- A specific precondition that must exist before the test (e.g. "a project must already exist in the account")

Things that are NOT requirements (do NOT list them):
- Navigating to a page or tab — the agent does that itself
- Clicking buttons, filling forms — the agent does that itself
- Accessing a URL — already configured separately
- Login credentials — already handled separately
- Anything described AS A STEP in the documentation

Return ONLY valid JSON (no markdown fences, no extra text).`

export function buildPreflightAnalysisPrompt(
  pageContent: string,
  pageTitle: string,
): string {
  return `## Documentation: "${pageTitle}"

${pageContent.slice(0, 8000)}

---

Identify ONLY the external resources needed BEFORE this test can start.

Return JSON:
{
  "testPlan": "1-2 sentence summary of what the test will verify — write in the SAME LANGUAGE as the documentation",
  "estimatedSteps": <number of distinct user actions the agent will perform>,
  "requirements": [
    {
      "category": "file" | "prerequisite",
      "label": "what is needed (same language as the doc)",
      "reason": "why this must be prepared before the test"
    }
  ]
}

Categories:
- "file": A specific file that must be uploaded during the test (PDF, video, image, spreadsheet, document, etc.)
- "prerequisite": A precondition that must be true (e.g. "an existing project must exist", "a subscription must be active")

Rules:
- ONLY include items that are truly external resources the agent cannot create on its own
- If the doc mentions uploading a file → add a "file" requirement
- If the doc requires pre-existing data that can't be created during the test → add a "prerequisite"
- Do NOT include URL, credentials, navigation steps, or UI actions — those are handled separately
- Keep the list SHORT — typically 0-3 items. An empty requirements array is perfectly fine
- Do NOT repeat documentation steps as requirements`
}

// --- Walkthrough (progressive AI-guided DOM highlighting) ---

import type { CompletedStep } from '../../features/chat/walkthrough.types.js'

export const WALKTHROUGH_SYSTEM_PROMPT = `You guide users through a product ONE STEP AT A TIME by mapping documentation to live DOM elements. Output ONLY valid JSON.

Given: documentation, current page DOM elements, and steps already completed.
Task: determine the ONE next action the user should take.

RULES:
1. Return exactly ONE step — the next logical action on the CURRENT page
2. Match the target element by text, aria-label, or role from the DOM list
3. elementRef = the element's "ref" from the DOM list. fallbackSelector = short CSS selector backup
4. If all doc steps are done, set done: true and step: null
5. instruction: under 80 chars, in the user's language
6. action: click | type | select | scroll | observe | navigate
7. For type: set typeValue. For navigate: instruction says where to go
8. hint: optional short note about what comes next (under 100 chars)
9. Think about prerequisite actions (open dropdown before selecting an item)`

/** Server-side PII redaction — defense in depth (widget also redacts client-side) */
function sanitizeForPrompt(text: string): string {
  if (!text) return text
  return text
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[email]')
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[card]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[token]')
    .replace(/\b(?:sk|pk|api|key|token|secret|password)[_-]?[a-zA-Z0-9]{16,}\b/gi, '[key]')
}

/** Strip query params and fragment from URL */
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.origin + parsed.pathname
  } catch {
    return url.split('?')[0]!.split('#')[0]!
  }
}

function formatDomElements(snapshot: DomSnapshot): string {
  if (snapshot.elements.length === 0) return 'No interactive elements found on this page.'

  return snapshot.elements
    .map((el) => {
      const parts = [`ref="${el.ref}"`, `tag=${el.tag}`]
      if (el.text) parts.push(`text="${sanitizeForPrompt(el.text)}"`)
      if (el.role) parts.push(`role=${el.role}`)
      if (el.ariaLabel) parts.push(`aria="${sanitizeForPrompt(el.ariaLabel)}"`)
      if (el.placeholder) parts.push(`placeholder="${sanitizeForPrompt(el.placeholder)}"`)
      parts.push(`pos=(${Math.round(el.rect.x)},${Math.round(el.rect.y)})`)
      parts.push(`selector="${el.selector}"`)
      return `- [${parts.join(' | ')}]`
    })
    .join('\n')
}

function formatCompletedSteps(steps: CompletedStep[]): string {
  if (steps.length === 0) return 'None yet — this is step 1.'
  return steps.map((s, i) => `${i + 1}. [${s.action}] ${s.instruction} (on ${sanitizeUrl(s.pageUrl)})`).join('\n')
}

export function buildWalkthroughPrompt(
  docContext: string,
  domSnapshot: DomSnapshot,
  message: string,
  completedSteps: CompletedStep[],
): string {
  const elementsBlock = formatDomElements(domSnapshot)
  const safeUrl = sanitizeUrl(domSnapshot.url)
  const completedBlock = formatCompletedSteps(completedSteps)

  return `DOCS:
${docContext || 'None'}

CURRENT PAGE: ${safeUrl}
DOM ELEMENTS:
${elementsBlock}

COMPLETED STEPS:
${completedBlock}

USER GOAL: ${message}

Return the ONE next step as JSON:
{"done":false,"step":{"instruction":"...","action":"click","elementRef":"ref","fallbackSelector":"sel","typeValue":null},"stepNumber":${completedSteps.length + 1},"hint":"next you'll..."}`
}
