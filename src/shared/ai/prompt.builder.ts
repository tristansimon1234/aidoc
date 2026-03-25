import type { StepSummary } from '../../features/exploration/exploration.types.js'

function formatStepsWithScreenshots(steps: StepSummary[]): string {
  if (steps.length === 0) return 'No steps recorded.'
  return steps
    .map((s, i) => {
      let entry = `Step ${i + 1}: [${s.url}]\n  Action: ${s.action}`
      if (s.observation) entry += `\n  Details: ${s.observation}`
      if (s.screenshotUrl) entry += `\n  Screenshot: ${s.screenshotUrl}`
      return entry
    })
    .join('\n\n')
}

export function buildDocumentationPrompt(context: {
  featureName: string
  goal: string
  startUrl: string
  steps: StepSummary[]
}): string {
  const screenshotSteps = context.steps.filter((s) => s.screenshotUrl)

  return `You are a product documentation writer. Generate a clear, user-friendly product guide that helps real users understand and use this feature.

## Product
Name: "${context.featureName}"
URL: ${context.startUrl}
Goal: "${context.goal}"

## Exploration Data
${formatStepsWithScreenshots(context.steps)}

## Available Screenshots
${screenshotSteps.length > 0
  ? screenshotSteps.map((s, i) => `Screenshot ${i + 1}: ${s.screenshotUrl}\n  Context: ${s.action}`).join('\n')
  : 'No screenshots available.'}

## Your Task
Write a **user-facing product guide** in Markdown. This is NOT an internal SOP — it's documentation that end users will read to understand how to use the product.

### Requirements:
1. Write in clear, friendly language (not corporate/technical jargon)
2. Include screenshots inline using Markdown image syntax: ![description](url)
3. Place screenshots at the relevant step — every major screen should have one
4. Focus on WHAT THE USER SEES and WHAT THEY SHOULD DO
5. Be specific: use actual button names, labels, and text from the app

### Document Structure:
1. **Introduction** — What this feature/product is and who it's for (2-3 sentences)
2. **Getting Started** — How to access the feature, any prerequisites
3. **Walkthrough** — Step-by-step guide with screenshots at each key step. Use numbered steps. For each step:
   - What the user sees on screen
   - What they should click/do
   - Include a screenshot if available
4. **Key Features** — Highlight important features discovered during exploration
5. **FAQ / Tips** — Common questions based on what was observed

### Formatting Rules:
- Use ## for sections, ### for subsections
- Use numbered lists for sequential steps
- Use bullet points for non-sequential info
- Include ALL relevant screenshots inline (don't just list them at the end)
- Use **bold** for UI element names (buttons, links, menu items)
- Keep paragraphs short (2-3 sentences max)

After the markdown, add a line containing "---JSON---", then a JSON summary:
{
  "featureName": "string",
  "totalSteps": number,
  "keyPages": ["url1", "url2"],
  "userActions": ["action1", "action2"],
  "screenshots": number
}`
}
