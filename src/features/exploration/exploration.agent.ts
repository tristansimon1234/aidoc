import { z } from 'zod'
import { anthropic, CLAUDE_MODEL } from '../../shared/ai/anthropic.client.js'
import { buildExplorationStepPrompt } from '../../shared/ai/prompt.builder.js'
import type { AnthropicUsage } from '../../shared/ai/anthropic.types.js'
import type { RunContext, AgentDecision } from './exploration.types.js'

const ContinueDecisionSchema = z.object({
  action: z.literal('continue'),
  nextAction: z.string(),
})

const AskDecisionSchema = z.object({
  action: z.literal('ask'),
  question: z.string(),
})

const BlockedDecisionSchema = z.object({
  action: z.literal('blocked'),
  reason: z.string(),
})

const FinishDecisionSchema = z.object({
  action: z.literal('finish'),
  summary: z.string(),
})

const AgentDecisionSchema = z.union([
  ContinueDecisionSchema,
  AskDecisionSchema,
  BlockedDecisionSchema,
  FinishDecisionSchema,
])

export interface AgentResult {
  decision: AgentDecision
  usage: AnthropicUsage
}

export async function getNextDecision(context: RunContext): Promise<AgentResult> {
  const prompt = buildExplorationStepPrompt(context)

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Anthropic')
  }

  const parsed = JSON.parse(textBlock.text) as unknown
  const decision = AgentDecisionSchema.parse(parsed)

  const usage: AnthropicUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  }

  return { decision, usage }
}
