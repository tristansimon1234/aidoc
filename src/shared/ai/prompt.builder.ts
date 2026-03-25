import type { RunContext, StepSummary } from '../../features/exploration/exploration.types.js'

function formatStepHistory(steps: StepSummary[]): string {
  if (steps.length === 0) return 'No steps taken yet.'
  return steps
    .map((s, i) => `Step ${i + 1}: [${s.url}] Action: ${s.action} → Result: ${s.observation}`)
    .join('\n')
}

export function buildExplorationStepPrompt(context: RunContext): string {
  return `You are an autonomous documentation agent exploring a web application using a cloud browser (Browserbase + Stagehand).

## Goal
Document the feature: "${context.featureName}"
User's goal: "${context.goal}"

## Current Page
- URL: ${context.currentStep.url}
- Title: ${context.currentStep.title}

## Available Actions on Page
${context.currentStep.observedActions || 'No actions observed yet.'}

## Step History
${formatStepHistory(context.stepHistory)}

## Previous Questions
${context.questionHistory.length > 0 ? context.questionHistory.map((q) => `Q: ${q.question} → A: ${q.answer ?? 'unanswered'}`).join('\n') : 'None'}

## Instructions
Analyze the current page and decide your next action. You can use natural language instructions — Stagehand will execute them on the browser.

Respond with a JSON object matching ONE of these formats:

1. Perform an action on the page (click, fill, scroll, etc.):
   {"action": "act", "instruction": "Click the 'Sign Up' button"}

2. Navigate to a URL:
   {"action": "navigate", "instruction": "https://example.com/settings"}

3. Ask the user a question (when blocked or need clarification):
   {"action": "ask", "question": "What credentials should I use to log in?"}

4. Blocked (cannot proceed at all):
   {"action": "blocked", "reason": "Page requires 2FA that I cannot bypass"}

5. Finished (goal fully achieved, you've explored enough):
   {"action": "finish", "summary": "Documented the checkout flow: homepage → cart → payment → confirmation. Key steps: ..."}

IMPORTANT: Be thorough. Explore all relevant screens, click through flows, fill forms with test data. Your exploration data will be used to generate SOP documentation.

Respond ONLY with the JSON object, no additional text.`
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
