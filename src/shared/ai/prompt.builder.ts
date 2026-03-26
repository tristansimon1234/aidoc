import type { StepSummary } from '../../features/exploration/exploration.types.js'

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
      if (s.screenshotUrl) entry += `\n- Screenshot: ![Step ${i + 1}](${s.screenshotUrl})`
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

**6. Known Gaps & Notes**
Be honest:
- What couldn't be fully documented and why
- Steps where content was unclear
- Areas that need re-exploration

**7. Suggested Next Steps**
What should be explored next to improve this documentation

### Screenshot Rules
- Place screenshots at the step they belong to — NOT grouped at the end
- Use: ![Descriptive caption](screenshot_url)
- Every KEY step with a screenshot should include it
- Don't describe what's in a screenshot if the image speaks for itself

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
