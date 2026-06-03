import { generateText, type GeminiUsage } from '../../shared/ai/gemini.client.js'
import {
  buildDocumentationPrompt,
  getDocSystemPrompt,
  VIDEO_DOC_SYSTEM_PROMPT,
  buildScreenshotMap,
  replaceScreenshotPlaceholders,
} from '../../shared/ai/prompt.builder.js'
import type { StepSummary } from '../exploration/exploration.types.js'

export interface GenerationResult {
  markdown: string
  /** Metadata blob persisted on `generated_docs.json_content`. We used
   *  to ship Gemini's self-assessment here (confidence %, gaps,
   *  nextSteps) but the signal added more noise than value: the AI
   *  rated itself, the user already knew the recording's gaps, and
   *  Try Doc gives a real validation pass. Now empty — kept as a slot
   *  in case we want to store something deterministic later. */
  json: Record<string, unknown>
  usage: GeminiUsage
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
 *  the prompt telling it not to. The legacy single-pass design used
 *  this separator; we kill any residue so it doesn't survive into the
 *  published markdown. */
function stripTrailingJsonTail(markdown: string): string {
  const idx = markdown.lastIndexOf('---JSON---')
  if (idx === -1) return markdown
  return markdown.slice(0, idx).trimEnd()
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
    // Exhaustive video-demo guides can be long (every feature documented with
    // its screenshot). Give Flash a high output budget so the markdown isn't
    // cut off mid-walkthrough; non-video docs stay well under this.
    maxTokens: 40000,
    systemPrompt,
    userPrompt,
  })

  let markdown = replaceScreenshotPlaceholders(stripTrailingJsonTail(response.text.trim()), buildScreenshotMap(context.steps))
  markdown = rewriteInternalLinks(markdown, context.projectId, context.knownSlugs)

  return {
    markdown,
    json: {},
    usage: response.usage,
  }
}
