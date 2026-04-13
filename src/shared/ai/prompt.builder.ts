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
      if (s.screenshotUrl && s.screenshotUrl.startsWith('http')) entry += `\n- Screenshot: ![Step ${i + 1}](${s.screenshotUrl})`
      return entry
    })
    .join('\n\n')
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

Write a **user-facing product guide** — the kind of documentation you'd find in a help center. Follow the same structure as for live explorations: Introduction, Getting Started, Walkthrough (group into logical flows), Key Features, FAQ/Tips. Embed screenshots at relevant steps using ![caption](url).

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
- Use: ![Descriptive caption](screenshot_url)
- If a step has no screenshot, describe the screen in vivid visual detail
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

  return `## Product
Name: "${context.featureName}"
URL: ${context.startUrl}
Goal: "${context.goal}"
${projectBlock}${tocBlock}${pageSummariesBlock}${statusBlock}
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

// --- Walkthrough (AI-guided DOM highlighting) ---

export const WALKTHROUGH_SYSTEM_PROMPT = `You are an interactive guide assistant. Given documentation about a product feature and a snapshot of the user's current page DOM, produce step-by-step walkthrough instructions that map to specific elements on the page.

## Rules
- Output ONLY valid JSON (no markdown fences, no extra text)
- Each step must reference an elementRef from the DOM list when the target element is visible
- If an element is not on the current page, set elementRef to null and notFound to true
- Keep instructions concise (under 80 characters each)
- action must be one of: click, type, select, scroll, observe, navigate
- For "type" actions, include typeValue with the suggested input
- Order steps logically as a user would perform them
- Maximum 15 steps per response
- If the guide spans multiple pages, include a pageNote explaining which steps require navigation
- Match the user's language (French → French, English → English)
- Think about prerequisite actions (e.g., open a dropdown before selecting an item)

## Matching Strategy
- Match elements by their visible text, aria-label, role, and tag
- Prefer elements with data-testid or id for elementRef
- Use fallbackSelector as a CSS selector that would uniquely identify the element
- If multiple elements match, prefer the one closest to the expected position in the workflow`

function formatDomElements(snapshot: DomSnapshot): string {
  if (snapshot.elements.length === 0) return 'No interactive elements found on this page.'

  return snapshot.elements
    .map((el) => {
      const parts = [`ref="${el.ref}"`, `tag=${el.tag}`]
      if (el.text) parts.push(`text="${el.text}"`)
      if (el.role) parts.push(`role=${el.role}`)
      if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`)
      parts.push(`pos=(${Math.round(el.rect.x)},${Math.round(el.rect.y)})`)
      parts.push(`selector="${el.selector}"`)
      return `- [${parts.join(' | ')}]`
    })
    .join('\n')
}

export function buildWalkthroughPrompt(
  docContext: string,
  domSnapshot: DomSnapshot,
  message: string,
  conversationHistory?: string,
): string {
  const elementsBlock = formatDomElements(domSnapshot)

  return `## Documentation Context
${docContext || 'No documentation context available.'}

## Current Page
URL: ${domSnapshot.url}
Title: ${domSnapshot.title}
Viewport: ${domSnapshot.viewport.width}x${domSnapshot.viewport.height}

## Interactive Elements on Page (${domSnapshot.elements.length} elements)
${elementsBlock}

${conversationHistory ? `## Conversation History\n${conversationHistory}\n` : ''}## User's Question
${message}

## Output Format
Respond with a JSON object matching this exact structure:
{
  "steps": [
    {
      "stepNumber": 1,
      "instruction": "Click the 'Create Project' button",
      "action": "click",
      "elementRef": "ref-value-from-dom-list",
      "fallbackSelector": "button.create-project",
      "typeValue": null,
      "notFound": false
    }
  ],
  "totalSteps": 5,
  "pageNote": null
}`
}
