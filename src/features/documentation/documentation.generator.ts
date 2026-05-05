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

/** Pull the JSON object out of `text`. Tolerant of:
 *  - ```json fenced code blocks
 *  - leading/trailing prose
 *  - the JSON appearing inline in the markdown if the separator was dropped
 *
 *  Returns the raw JSON string, or null if no plausible block was found.
 */
function extractJsonBlock(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // Fenced block has highest priority — its delimiters are unambiguous.
  const fence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fence?.[1]) return fence[1].trim()

  // Otherwise scan for the LAST `{ ... }` block — most common when
  // Gemini forgets the separator and just appends the JSON after the
  // final markdown paragraph.
  const lastOpen = trimmed.lastIndexOf('{')
  if (lastOpen === -1) return null
  // Walk forward to find the matching brace that closes the document.
  let depth = 0
  let start = -1
  for (let i = trimmed.indexOf('{'); i < trimmed.length && i !== -1; i++) {
    const ch = trimmed[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        // Capture this candidate; keep scanning in case a later block
        // is the actual self-assessment (we want the last one).
        const candidate = trimmed.slice(start, i + 1)
        // Heuristic: real assessment includes the schema's required key.
        if (candidate.includes('"selfAssessment"')) return candidate
      }
    }
  }
  // No `selfAssessment` keyword anywhere — give up rather than return a
  // random JSON-shaped substring (e.g. an example from the doc body).
  return null
}

interface DocContext {
  featureName: string
  steps: { url: string; action: string; observation?: string; screenshotUrl?: string | null }[]
}

function parseSelfAssessment(rawTail: string, context: DocContext): Record<string, unknown> {
  const block = extractJsonBlock(rawTail)
  if (!block) {
    console.warn('[doc] No JSON block found in Gemini response — self-assessment will be missing.')
    return missingSelfAssessment(context, 'no-json-block')
  }
  try {
    const parsed = JSON.parse(block) as unknown
    return DocJsonSchema.parse(parsed) as unknown as Record<string, unknown>
  } catch (err) {
    const preview = block.slice(0, 200).replace(/\s+/g, ' ')
    console.warn(`[doc] Failed to parse self-assessment JSON: ${(err as Error).message}. Preview: ${preview}`)
    return missingSelfAssessment(context, 'parse-failed')
  }
}

/** Sentinel fallback used when Gemini's self-assessment can't be parsed.
 *  Marked with `parseFailed: true` so the UI can render "Assessment
 *  unavailable" instead of the misleading "0 % confidence" we used to
 *  show. `overallCompleteness` is left undefined for the same reason. */
function missingSelfAssessment(context: DocContext, reason: 'no-json-block' | 'parse-failed'): Record<string, unknown> {
  return {
    featureName: context.featureName,
    totalSteps: context.steps.length,
    keyPages: [],
    userActions: [],
    screenshots: 0,
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
    // Bumped from 16k — long docs were eating the token budget before
    // Gemini got to the trailing self-assessment JSON, leaving it
    // truncated and unparseable. Banner then displayed a misleading
    // 0 % confidence because the fallback path defaulted to 0.
    maxTokens: 32768,
  })

  // Robust split: prefer the explicit `---JSON---` separator the prompt
  // asks for, but fall back to "everything before the trailing JSON
  // block" if Gemini drops the separator. We always look at the LAST
  // `{ ... }` block on the page to avoid grabbing inline `{example}` from
  // mid-doc snippets.
  const sep = response.text.lastIndexOf('---JSON---')
  let markdownPart: string
  let jsonPart: string
  if (sep >= 0) {
    markdownPart = response.text.slice(0, sep)
    jsonPart = response.text.slice(sep + '---JSON---'.length)
  } else {
    markdownPart = response.text
    jsonPart = ''
  }

  // Replace screenshot placeholders with actual URLs (Gemini can't reproduce UUIDs reliably)
  const screenshotMap = buildScreenshotMap(context.steps)
  let markdown = replaceScreenshotPlaceholders(markdownPart.trim(), screenshotMap)
  // Rewrite Gemini-generated `/slug` links to absolute public-doc URLs so they
  // resolve consistently in both the editor and the public docs SPA.
  markdown = rewriteInternalLinks(markdown, context.projectId, context.knownSlugs)

  // Strip ```json … ``` fences and grab the outer-most { ... } block.
  // Gemini wraps the JSON in fences ~30 % of the time, sometimes adds
  // a closing prose line after it ("Hope this helps!"), and on the
  // hardest path emits the JSON inline in the markdown if it forgot
  // the separator.
  const json = parseSelfAssessment(jsonPart || markdownPart, context)

  return {
    markdown,
    json,
    usage: response.usage,
  }
}
