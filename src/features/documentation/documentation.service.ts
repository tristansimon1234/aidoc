import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import * as docRepo from './documentation.repository.js'
import { generateDocumentation } from './documentation.generator.js'
import { getPublicUrl } from '../../shared/db/storage.repository.js'
import type { GeneratedDoc } from './documentation.types.js'
import type { StepSummary } from '../exploration/exploration.types.js'

export interface DocDeps {
  findRunById: (id: string) => Promise<{
    featureName: string
    goal: string
    startUrl: string
    status: string
    tokenUsage: number
    docPageId: string | null
    browserbaseSessionId?: string | null
  } | null>
  findStepsByRunId: (runId: string) => Promise<
    { url: string | null; action: string | null; observation: string | null; screenshotPath: string | null }[]
  >
  findQuestionsByRunId: (runId: string) => Promise<
    { question: string; answer: string | null }[]
  >
  incrementTokenUsage: (id: string, tokens: number) => Promise<void>
}

export interface DocGenerationOptions {
  projectContext?: string
  tableOfContents?: string
  existingPageSummaries?: { title: string; slug: string; contentPreview: string }[]
  language?: string
}

export async function getDocByRunId(runId: string): Promise<GeneratedDoc> {
  const doc = await docRepo.findDocByRunId(runId)
  if (!doc) throw new NotFoundError('Document')
  return doc
}

export async function generateAndSaveDoc(
  runId: string,
  deps: DocDeps,
  options?: DocGenerationOptions,
): Promise<GeneratedDoc> {
  const run = await deps.findRunById(runId)
  if (!run) throw new NotFoundError('Run')

  const steps = await deps.findStepsByRunId(runId)
  const questions = await deps.findQuestionsByRunId(runId)

  // Filter noisy supporting steps (only for browser explorations, not video)
  const isVideoRun = !run.browserbaseSessionId
  const noiseTools = new Set(['scroll', 'ariaTree', 'wait', 'keys', 'screenshot'])
  const filteredSteps = isVideoRun ? steps : steps.filter((s) => {
    const toolType = (s.action ?? '').split(' ')[0]?.toLowerCase() ?? ''
    return !noiseTools.has(toolType)
  })

  const stepSummaries: StepSummary[] = filteredSteps.map((s, i) => {
    let screenshotUrl = s.screenshotPath ? getPublicUrl('artifacts', s.screenshotPath) : null
    // Fallback for video runs: frames stored at conventional path
    if (!screenshotUrl && isVideoRun) {
      screenshotUrl = getPublicUrl('artifacts', `runs/${runId}/frame-${i}.jpg`)
    }
    return {
      url: s.url ?? '',
      action: s.action ?? '',
      observation: (s.observation ?? '').slice(0, 500),
      screenshotUrl,
    }
  })
  console.log(`[doc] ${stepSummaries.length} steps, ${stepSummaries.filter(s => s.screenshotUrl).length} with screenshots`)

  const result = await generateDocumentation({
    featureName: run.featureName,
    goal: run.goal,
    startUrl: run.startUrl,
    steps: stepSummaries,
    questions: questions.map((q) => ({ question: q.question, answer: q.answer })),
    projectContext: options?.projectContext,
    tableOfContents: options?.tableOfContents,
    existingPageSummaries: options?.existingPageSummaries,
    runStatus: run.status,
    isVideoRun: !run.browserbaseSessionId,
    language: options?.language,
  })

  await deps.incrementTokenUsage(runId, result.usage.inputTokens + result.usage.outputTokens)

  return docRepo.upsertDoc({
    runId,
    docPageId: run.docPageId ?? undefined,
    markdownContent: result.markdown,
    jsonContent: result.json,
  })
}
