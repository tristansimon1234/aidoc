import { z } from 'zod'
import { generateText, type GeminiUsage } from '../../shared/ai/gemini.client.js'
import { buildDocumentationPrompt, getDocSystemPrompt, VIDEO_DOC_SYSTEM_PROMPT, buildScreenshotMap, replaceScreenshotPlaceholders } from '../../shared/ai/prompt.builder.js'
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
  usage: GeminiUsage
}

function rewriteInternalLinks(markdown: string, projectId?: string, knownSlugs?: string[]): string {
  if (!projectId || !knownSlugs || knownSlugs.length === 0) return markdown
  const slugSet = new Set(knownSlugs)
  return markdown.replace(
    /\]\(\/([a-z0-9][a-z0-9-]*)(#[^)]*)?\)/gi,
    (match, slug: string, hash: string | undefined) => {
      if (!slugSet.has(slug)) return match
      return `](/docs/${projectId}/${slug}${hash ?? ''})`
    },
  )
}

export async function generateDocumentation(context: {
  featureName: string
  goal: string
  startUrl: string
  steps: StepSummary[]
  projectContext?: string
  tableOfContents?: string
  questions?: { question: string; answer: string | null }[]
  existingPageSummaries?: { title: string; slug: string; contentPreview: string }[]
  runStatus?: string
  isVideoRun?: boolean
  projectId?: string
  knownSlugs?: string[]
}): Promise<GenerationResult> {
  const systemPrompt = context.isVideoRun ? VIDEO_DOC_SYSTEM_PROMPT : getDocSystemPrompt()
  const userPrompt = buildDocumentationPrompt(context)

  const response = await generateText({
    systemPrompt,
    userPrompt,
    maxTokens: 16384,
  })

  const parts = response.text.split('---JSON---')
  // Replace screenshot placeholders with actual URLs (Gemini can't reproduce UUIDs reliably)
  const screenshotMap = buildScreenshotMap(context.steps)
  let markdown = replaceScreenshotPlaceholders(parts[0]?.trim() ?? '', screenshotMap)
  // Rewrite Gemini-generated `/slug` links to absolute public-doc URLs so they
  // resolve consistently in both the editor and the public docs SPA.
  markdown = rewriteInternalLinks(markdown, context.projectId, context.knownSlugs)
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
    usage: response.usage,
  }
}
