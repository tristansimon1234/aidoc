import type { StepSummary } from '../../features/exploration/exploration.types.js'
import type { DiscoveredContext } from '../../features/project/project.types.js'

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
      const importance = importantTools.has(toolType) ? 'KEY' : supportTools.has(toolType) ? 'supporting' : 'KEY'

      let entry = `### Step ${i + 1} [${importance}]`
      entry += `\n- URL: ${s.url}`
      entry += `\n- Action: ${s.action}`
      if (s.observation) entry += `\n- Agent reasoning: ${s.observation.slice(0, 500)}`
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
${context.runStatus === 'blocked' ? '- ⚠️ Exploration was INCOMPLETE — document what was found but clearly flag gaps' : ''}
${context.runStatus === 'failed' ? '- ⚠️ Exploration FAILED — generate best-effort doc from available data' : ''}

IMPORTANT: If the exploration shows that the agent could NOT access certain features (failed login, access denied, errors), do NOT document those features as if they worked. Instead:
- Only document what was actually successfully explored and seen
- If a section was blocked, briefly mention it needs separate documentation
- Do NOT pad the document with speculation about blocked features
- Keep the document focused and honest — short and accurate is better than long and fabricated
`

  return `You are an expert product documentation writer. Your job is to transform raw exploration data into a clear, professional, user-friendly guide.

## Product
Name: "${context.featureName}"
URL: ${context.startUrl}
Goal: "${context.goal}"
${projectBlock}${tocBlock}${pageSummariesBlock}${statusBlock}
## Exploration Data

The following steps were captured by an AI agent exploring the web application. Steps marked [KEY] are important user actions. Steps marked [supporting] are navigation/setup actions.

${formatStepsRich(context.steps)}
${blockersSection}
## Your Task

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
${counts.withScreenshots < counts.key / 2 ? `\n⚠️ WARNING: Only ${counts.withScreenshots} out of ${counts.key} key steps have screenshots. Compensate missing screenshots with detailed visual descriptions of what the user sees on screen.\n` : ''}

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

Be brutally honest in the self-assessment. A 40% completeness with clear gaps is better than 90% that hides problems.`
}
