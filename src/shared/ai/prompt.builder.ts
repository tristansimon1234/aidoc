import type { StepSummary } from '../../features/exploration/exploration.types.js'

function formatStepHistory(steps: StepSummary[]): string {
  if (steps.length === 0) return 'No steps recorded.'
  return steps
    .map((s, i) => `Step ${i + 1}: [${s.url}] Action: ${s.action} → Result: ${s.observation}`)
    .join('\n')
}

export function buildDocumentationPrompt(context: {
  featureName: string
  goal: string
  steps: StepSummary[]
}): string {
  return `You are a technical documentation writer. Generate a structured SOP (Standard Operating Procedure) document based on the following exploration data.

## Feature
Name: "${context.featureName}"
Goal: "${context.goal}"

## Exploration Steps
${formatStepHistory(context.steps)}

## Output Format
Generate a comprehensive SOP document in Markdown format with these sections:

1. **Overview** — Brief description of the feature
2. **Prerequisites** — What the user needs before starting
3. **Step-by-Step Instructions** — Detailed walkthrough with numbered steps
4. **Expected Results** — What the user should see at each step
5. **Troubleshooting** — Common issues and solutions
6. **Architecture Notes** — Simple feature architecture summary

Also generate a JSON summary with this structure:
{
  "featureName": "string",
  "totalSteps": number,
  "keyPages": ["url1", "url2"],
  "userActions": ["action1", "action2"],
  "blockers": ["blocker1"]
}

Respond with the Markdown document first, then a line containing "---JSON---", then the JSON summary.`
}
