import type { RunContext, StepSummary } from '../../features/exploration/exploration.types.js'

function formatStepHistory(steps: StepSummary[]): string {
  if (steps.length === 0) return 'No steps taken yet.'
  return steps
    .map((s, i) => `Step ${i + 1}: [${s.url}] Action: ${s.action} → Observation: ${s.observation}`)
    .join('\n')
}

export function buildExplorationStepPrompt(context: RunContext): string {
  return `You are an autonomous documentation agent exploring a web application.

## Goal
Document the feature: "${context.featureName}"
User's goal: "${context.goal}"

## Current State
- Current URL: ${context.currentStep.url}
- Page title: ${context.currentStep.title}
- Visible elements: ${context.currentStep.visibleElements}

## Step History
${formatStepHistory(context.stepHistory)}

## Previous Questions
${context.questionHistory.length > 0 ? context.questionHistory.map((q) => `Q: ${q.question} → A: ${q.answer ?? 'unanswered'}`).join('\n') : 'None'}

## Instructions
Analyze the current page state and decide your next action. Respond with a JSON object matching one of these formats:

1. Continue exploring:
   {"action": "continue", "nextAction": "click #submit-button"}

2. Ask user a question (when blocked or need clarification):
   {"action": "ask", "question": "What credentials should I use to log in?"}

3. Blocked (cannot proceed):
   {"action": "blocked", "reason": "Page requires 2FA authentication"}

4. Finished (goal achieved):
   {"action": "finish", "summary": "Successfully documented the checkout flow..."}

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
Generate a comprehensive SOP document in Markdown format with the following sections:

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
