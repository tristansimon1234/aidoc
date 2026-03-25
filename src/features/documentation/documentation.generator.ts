import { z } from 'zod'
import { anthropic, CLAUDE_MODEL } from '../../shared/ai/anthropic.client.js'
import { buildDocumentationPrompt } from '../../shared/ai/prompt.builder.js'
import type { AnthropicUsage } from '../../shared/ai/anthropic.types.js'
import type { StepSummary } from '../exploration/exploration.types.js'

const DocJsonSchema = z.object({
  featureName: z.string(),
  totalSteps: z.number(),
  keyPages: z.array(z.string()),
  userActions: z.array(z.string()),
  blockers: z.array(z.string()),
})

export interface GenerationResult {
  markdown: string
  json: Record<string, unknown>
  usage: AnthropicUsage
}

export async function generateDocumentation(context: {
  featureName: string
  goal: string
  steps: StepSummary[]
}): Promise<GenerationResult> {
  const prompt = buildDocumentationPrompt(context)

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Anthropic')
  }

  const parts = textBlock.text.split('---JSON---')
  const markdown = parts[0]?.trim() ?? ''
  const jsonStr = parts[1]?.trim() ?? '{}'

  const parsed = JSON.parse(jsonStr) as unknown
  const json = DocJsonSchema.parse(parsed)

  return {
    markdown,
    json: json as unknown as Record<string, unknown>,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  }
}
