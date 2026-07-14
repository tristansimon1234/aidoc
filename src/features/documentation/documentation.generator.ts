import { z } from 'zod'
import { generateText, type GeminiUsage } from '../../shared/ai/gemini.client.js'
import {
  buildDocumentationPrompt,
  buildSelfAssessmentPrompt,
  getDocSystemPrompt,
  SELF_ASSESSMENT_RESPONSE_SCHEMA,
  VIDEO_DOC_SYSTEM_PROMPT,
  buildScreenshotMap,
  replaceScreenshotPlaceholders,
} from '../../shared/ai/prompt.builder.js'
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

const SelfAssessmentSchema = z.object({
  overallCompleteness: z.number().min(0).max(100),
  stepAssessments: z.array(StepAssessmentSchema),
  gaps: z.array(GapSchema),
  nextSteps: z.array(NextStepSchema),
})

export interface GenerationResult {
  markdown: string
  json: Record<string, unknown>
  usage: GeminiUsage
}

interface DocContext {
  featureName: string
  steps: StepSummary[]
}

/** Sentinel fallback used when the structured-output assessment call
 *  itself fails (network, safety block, malformed schema response).
 *  Marked with `parseFailed: true` so the UI renders "Assessment
 *  unavailable" instead of misleading "0 % confidence". */
function missingSelfAssessment(context: DocContext, reason: 'call-failed' | 'validation-failed'): Record<string, unknown> {
  return {
    featureName: context.featureName,
    totalSteps: context.steps.length,
    selfAssessment: {
      parseFailed: true,
      parseFailureReason: reason,
      stepAssessments: [],
      gaps: [],
      nextSteps: [],
    },
  }
}

function rewriteInternalLinks(markdown: string, projectId?: string, knownSlugs?: string[]): string {
  if (!projectId) return markdown
  const slugSet = new Set(knownSlugs ?? [])
  // `knownSlugs` is the list of published public pages in the project. Anything
  // else (draft/private page, hallucinated slug, deleted page) gets stripped to
  // plain text so we never ship a 404 link in generated docs.
  return markdown.replace(
    /\[([^\]]+)\]\(\/(?:docs\/[a-f0-9-]+\/)?([a-z0-9][a-z0-9-]*)(#[^)]*)?\)/gi,
    (_match, label: string, slug: string, hash: string | undefined) => {
      if (!slugSet.has(slug)) return label
      return `[${label}](/docs/${projectId}/${slug}${hash ?? ''})`
    },
  )
}

/** Strip a stray `---JSON---{...}` tail if Gemini emitted one despite
 *  the prompt now telling it not to. Cheap belt-and-braces — the second
 *  pass owns the assessment, but we don't want a fake JSON tail
 *  surviving into the published markdown. */
function stripTrailingJsonTail(markdown: string): string {
  const idx = markdown.lastIndexOf('---JSON---')
  if (idx === -1) return markdown
  return markdown.slice(0, idx).trimEnd()
}

/** Run the structured self-assessment call. Uses Gemini's
 *  `responseSchema` so the model can't drift the shape — the API
 *  rejects any deviation server-side. Falls back to a "parseFailed"
 *  sentinel on call / validation errors so the banner stays informative
 *  rather than crashing the whole doc-gen on a flaky second pass. */
async function runSelfAssessment(
  markdown: string,
  context: DocContext & { projectContext?: string },
): Promise<{ json: Record<string, unknown>; usage: GeminiUsage }> {
  const userPrompt = buildSelfAssessmentPrompt({
    markdown,
    steps: context.steps,
    projectContext: context.projectContext,
  })

  let result: { text: string; usage: GeminiUsage }
  try {
    result = await generateText({
      userPrompt,
      json: true,
      responseSchema: SELF_ASSESSMENT_RESPONSE_SCHEMA,
      maxTokens: 4096,
      temperature: 0.2,
      // No reasoning needed — we hand Gemini the doc and ask for a
      // structured rating. Letting "thinking" run wastes the token
      // budget without improving output.
      thinkingBudget: 0,
    })
  } catch (err) {
    console.warn(`[doc] Self-assessment call failed: ${(err as Error).message}`)
    return { json: missingSelfAssessment(context, 'call-failed'), usage: { inputTokens: 0, outputTokens: 0 } }
  }

  if (!result.text) {
    console.warn('[doc] Self-assessment returned empty text — banner will show unavailable.')
    return { json: missingSelfAssessment(context, 'call-failed'), usage: result.usage }
  }

  try {
    const parsed = JSON.parse(result.text) as unknown
    const validated = SelfAssessmentSchema.parse(parsed)
    return {
      json: {
        featureName: context.featureName,
        totalSteps: context.steps.length,
        selfAssessment: validated,
      },
      usage: result.usage,
    }
  } catch (err) {
    const preview = result.text.slice(0, 200).replace(/\s+/g, ' ')
    console.warn(`[doc] Self-assessment JSON validation failed: ${(err as Error).message}. Preview: ${preview}`)
    return { json: missingSelfAssessment(context, 'validation-failed'), usage: result.usage }
  }
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

  // --- Pass 1: markdown only ---
  // The system prompt now explicitly tells Gemini not to emit any
  // trailing JSON; the assessment is generated in a separate
  // schema-constrained call below so the model can't hallucinate the
  // shape (which is what blew up the original single-pass design).
  const mdResponse = await generateText({
    systemPrompt,
    userPrompt,
    maxTokens: 24576,
  })

  let markdown = replaceScreenshotPlaceholders(stripTrailingJsonTail(mdResponse.text.trim()), buildScreenshotMap(context.steps))
  markdown = rewriteInternalLinks(markdown, context.projectId, context.knownSlugs)

  // --- Pass 2: structured self-assessment ---
  const assessment = await runSelfAssessment(markdown, context)

  return {
    markdown,
    json: assessment.json,
    usage: {
      inputTokens: mdResponse.usage.inputTokens + assessment.usage.inputTokens,
      outputTokens: mdResponse.usage.outputTokens + assessment.usage.outputTokens,
    },
  }
}
