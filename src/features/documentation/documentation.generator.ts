import { z } from 'zod'
import { anthropic, CLAUDE_MODEL } from '../../shared/ai/anthropic.client.js'
import { buildDocumentationPrompt } from '../../shared/ai/prompt.builder.js'
import type { AnthropicUsage } from '../../shared/ai/anthropic.types.js'
import type { StepSummary } from '../exploration/exploration.types.js'

const StepAssessmentSchema = z.object({
  stepIndex: z.number(),
  confidence: z.enum(['high', 'medium', 'low']),
  note: z.string().nullable(),
})

const GapSchema = z.object({
  area: z.string(),
  reason: z.string(),
  severity: z.enum(['major', 'minor']),
})

const NextStepSchema = z.object({
  suggestion: z.string(),
  reason: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
})

const StructuralSuggestionSchema = z.object({
  type: z.enum(['move', 'merge', 'split', 'rename', 'new']),
  targetSlug: z.string().optional(),
  details: z.string(),
  suggestedTitle: z.string().optional(),
  suggestedParentSlug: z.string().optional(),
})

const SelfAssessmentSchema = z.object({
  overallCompleteness: z.number().min(0).max(100),
  stepAssessments: z.array(StepAssessmentSchema),
  gaps: z.array(GapSchema),
  nextSteps: z.array(NextStepSchema),
  structuralSuggestions: z.array(StructuralSuggestionSchema).optional(),
})

const DocJsonSchema = z.object({
  featureName: z.string(),
  totalSteps: z.number(),
  keyPages: z.array(z.string()),
  userActions: z.array(z.string()),
  screenshots: z.number().optional(),
  selfAssessment: SelfAssessmentSchema,
})

export interface GenerationResult {
  markdown: string
  json: Record<string, unknown>
  usage: AnthropicUsage
}

export async function generateDocumentation(context: {
  featureName: string
  goal: string
  startUrl: string
  steps: StepSummary[]
  projectContext?: string
  tableOfContents?: string
  questions?: { question: string; answer: string | null }[]
}): Promise<GenerationResult> {
  const prompt = buildDocumentationPrompt(context)

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Anthropic')
  }

  const parts = textBlock.text.split('---JSON---')
  const markdown = parts[0]?.trim() ?? ''
  const jsonStr = parts[1]?.trim() ?? '{}'

  let json: Record<string, unknown>
  try {
    const parsed = JSON.parse(jsonStr) as unknown
    json = DocJsonSchema.parse(parsed) as unknown as Record<string, unknown>
  } catch {
    json = {
      featureName: context.featureName,
      totalSteps: context.steps.length,
      keyPages: [],
      userActions: [],
      screenshots: 0,
      selfAssessment: {
        overallCompleteness: 0,
        stepAssessments: [],
        gaps: [{ area: 'Entire documentation', reason: 'Self-assessment could not be parsed', severity: 'major' }],
        nextSteps: [],
      },
    }
  }

  return {
    markdown,
    json,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  }
}
