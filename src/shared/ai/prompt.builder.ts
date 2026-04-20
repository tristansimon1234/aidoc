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
 *
 * Gemini sometimes drops the `![caption](...)` wrapper and leaves a bare
 * `{{SCREENSHOT_N}}` placeholder on its own line — which would render as a
 * plain link instead of an embedded image. We handle both cases:
 *   1. `![caption]({{SCREENSHOT_N}})` → `![caption](url)` (image embed preserved)
 *   2. Bare `{{SCREENSHOT_N}}` → `![Screenshot](url)` (wrap so it renders inline)
 */
export function replaceScreenshotPlaceholders(markdown: string, screenshotMap: Map<string, string>): string {
  let result = markdown
  const missing: string[] = []
  for (const [placeholder, url] of screenshotMap) {
    if (!result.includes(placeholder)) {
      missing.push(`![Screenshot](${url})`)
      continue
    }
    // Replace placeholders already inside image syntax first
    const escapedPlaceholder = placeholder.replace(/[{}]/g, '\\$&')
    const imageSyntaxRegex = new RegExp(`!\\[([^\\]]*)\\]\\(${escapedPlaceholder}\\)`, 'g')
    result = result.replace(imageSyntaxRegex, `![$1](${url})`)
    // Any remaining bare occurrences get wrapped so they render as an embedded image
    result = result.replaceAll(placeholder, `![Screenshot](${url})`)
  }
  // Append missed screenshots so no image is lost
  if (missing.length > 0) {
    result += '\n\n' + missing.join('\n\n')
  }
  // Defense in depth: promote any remaining bare image URLs that sit alone on a
  // line to markdown image embeds. Catches cases where Gemini inlined a raw
  // storage URL instead of using the placeholder syntax.
  result = wrapBareImageUrls(result)
  return result
}

/**
 * Wrap bare image URLs that appear alone on their own line as markdown image
 * embeds. Only matches known image extensions so we don't grab unrelated links.
 */
function wrapBareImageUrls(markdown: string): string {
  const bareImageLineRegex = /^(\s*)(https?:\/\/\S+\.(?:jpg|jpeg|png|webp|gif|avif))(\s*)$/gim
  return markdown.replace(bareImageLineRegex, (_match, lead: string, url: string, trail: string) =>
    `${lead}![Screenshot](${url})${trail}`,
  )
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

Write a **user-facing product guide** — the kind of documentation you'd find in a help center. Follow the same structure as for live explorations: Introduction, Getting Started, Walkthrough (group into logical flows), Key Features, FAQ/Tips. Embed screenshots at relevant steps using their {{SCREENSHOT_N}} placeholders exactly as provided. CRITICAL: each screenshot must be on its own paragraph with a blank line before and after — never inside a list item or on the same line as text.

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
- CRITICAL FORMATTING: Each screenshot MUST be on its own paragraph, separated by a blank line before AND after. Never put a screenshot on the same line as text or inside a list item. Example:

1. Click the **New Page** button.

![New Page button]({{SCREENSHOT_0}})

2. Fill in the form fields.

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
    ? `\n## Other Pages in This Documentation\n${context.tableOfContents}\nWhen referencing content covered by other pages, use markdown links like [Page Title](/slug). Do NOT duplicate content. ONLY link to slugs listed above — never invent or guess page URLs. If a topic isn't listed, write it inline instead of linking.\n`
    : `\n## Other Pages in This Documentation\n(none yet)\nDo NOT create links to other doc pages — write everything inline.\n`

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
1. Return exactly ONE step — the next logical action on the CURRENT page OR a navigation step to a different page if that's what the flow requires.
2. Match the target element by text, aria-label, or role from the DOM list
3. elementRef MUST be copied EXACTLY from a ref="..." value in the DOM list — never invent one, never reuse a ref from a previous step, never abbreviate. If no DOM element matches the target, set elementRef=null (the widget will show a textual hint instead). fallbackSelector = short CSS selector backup; keep it specific to THIS element (prefer \`#id\` or \`[data-testid="..."]\` over generic tag selectors).
4. done=true ONLY when the user has fully completed the goal (reached the success state). An uncertain element match, a missing DOM node, or "I'm not sure what to click" is NEVER a reason to set done=true — emit a textual step instead (see Confidence rules). The walkthrough must continue across pages.
5. instruction: under 80 chars, in the user's language
6. action: click | type | select | scroll | observe | navigate
7. For type: set typeValue. For navigate: instruction says where to go
8. hint: optional short note about what comes next (under 100 chars)
9. Think about prerequisite actions (open dropdown before selecting an item)

CONFIDENCE — WHEN NOT SURE, DESCRIBE INSTEAD OF POINTING:
- If you can't confidently match the user's goal to a SPECIFIC element in the DOM list (no clear text/aria match, ambiguous between many candidates, element likely lives in a menu that isn't open, target might not be rendered yet, user is on the wrong page), set elementRef=null and fallbackSelector=null.
- In that case, phrase the instruction as a concrete search + action the user can perform themselves. Examples:
   "Find the 'Publish' toggle in the top-right and click it."
   "Open the sidebar and locate the Analytics tab."
   "Scroll to the Team section at the bottom of the Settings page."
   "Navigate to Account → Team to see who's on your workspace."
- Better to tell the user what to look for than to ring an irrelevant element — a bad highlight breaks trust faster than a clear textual hint.
- Still set action correctly so the widget knows what's being asked.
- Keep going on the next step after the user confirms they've done it, even if you had to fall back to a textual hint. Don't end the walkthrough early just because one step couldn't be pinpointed.`

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

// --- Per-message classifier (write-time) ---

export const MESSAGE_CLASSIFIER_SYSTEM_PROMPT = `You classify a single chat message from an end-user talking to a product's help chatbot.

Return ONLY a minified JSON object with these four fields:
- sentiment: "positive" | "neutral" | "negative"
- frustrated: boolean — true if the user sounds irritated, stuck, blocked, or resigned (not just asking a question)
- language: 2-letter ISO 639-1 code (e.g. "fr", "en", "es")
- category: one of "onboarding" | "pricing" | "how-to" | "error" | "integration" | "account" | "other"

Category rules (pick exactly one):
- "onboarding" — first steps, getting started, what is this product, quickstart
- "pricing" — plans, price, upgrade, billing, trial
- "how-to" — "how do I X", feature usage questions, workflow steps
- "error" — something broken, bug, doesn't work, "ça marche pas"
- "integration" — API, webhooks, SDK, third-party connection
- "account" — login, signup, password, profile, settings, permissions
- "other" — greetings, thanks, meta questions, or anything that doesn't fit above

Sentiment rules:
- Neutral is the default. Don't over-flag negativity on plain questions.
- "frustrated" requires real signals: complaints ("nul", "broken", "useless", "ça marche pas"), repeated tries ("encore", "again"), giving-up tone, or explicit anger. Asking "how do I X?" is NEUTRAL, not frustrated.
- If the message is a greeting or acknowledgement, return neutral + frustrated:false + category:"other".
- No explanation, no markdown, just the JSON.`

export function buildMessageClassifierPrompt(content: string): string {
  // Hard cap to keep the prompt tiny — frustration signals are at the surface.
  const trimmed = content.length > 500 ? `${content.slice(0, 500)}…` : content
  return `Classify this message:\n"""${trimmed}"""`
}

// --- On-demand recommendations (triggered by the owner, not automatic) ---

export const ANALYTICS_SYSTEM_PROMPT = `You are a senior product analyst. You receive anonymised end-user questions pulled from a chatbot that answers from a product's documentation, plus the list of docs most visited.

Produce actionable recommendations as STRICT JSON — no prose before or after.

Rules:
- Base everything on the actual messages provided. No invented themes.
- Write EVERY field in the dominant language of the user messages (French → French, English → English).
- Recommendations must be specific and tied to observed evidence — no generic "improve onboarding". Reference the concrete pattern you saw.
- type='content' → edit/create a doc page. type='product' → change the product. type='ux' → fix UX flow.
- If the sample is too small or too generic, return an empty \`items\` array and a neutral \`summary\`. Never hallucinate.`

export function buildAnalyticsPrompt(input: {
  productName: string
  productDescription: string | null
  sessionCount: number
  messageCount: number
  sampleUserMessages: string[]
  topPages: { title: string | null; slug: string; views: number }[]
  allPageTitles: string[]
}): string {
  const messagesBlock = input.sampleUserMessages.length > 0
    ? input.sampleUserMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')
    : '(no user messages in this period)'

  const topPagesBlock = input.topPages.length > 0
    ? input.topPages.map((p) => `- ${p.title ?? p.slug} (/${p.slug}): ${p.views} views`).join('\n')
    : '(no page views in this period)'

  const pageListBlock = input.allPageTitles.length > 0 ? input.allPageTitles.join(', ') : '(no pages yet)'

  return `## Product
${input.productName}${input.productDescription ? `\n${input.productDescription}` : ''}

## Documentation pages (all)
${pageListBlock}

## Period metrics
- Unique sessions: ${input.sessionCount}
- Chat messages: ${input.messageCount}

## Most-viewed public doc pages
${topPagesBlock}

## Sample user questions (most recent first, max 200)
${messagesBlock}

## Task
Produce a JSON object with this exact shape:
{
  "summary": "one or two sentences naming the dominant themes and what to prioritise, in the users' language",
  "items": [
    { "type": "content"|"product"|"ux", "title": "", "description": "", "priority": "high"|"medium"|"low" }
  ]
}

Return ONLY the JSON object.`
}
