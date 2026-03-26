import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import * as docRepo from './documentation.repository.js'
import { generateDocumentation } from './documentation.generator.js'
import { getSignedUrl } from '../../shared/db/storage.repository.js'
import type { GeneratedDoc } from './documentation.types.js'
import type { StepSummary } from '../exploration/exploration.types.js'

export interface DocDeps {
  findRunById: (id: string) => Promise<{
    featureName: string
    goal: string
    startUrl: string
    tokenUsage: number
    docPageId: string | null
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

  const stepSummaries: StepSummary[] = await Promise.all(
    steps.map(async (s) => {
      let screenshotUrl: string | null = null
      if (s.screenshotPath) {
        screenshotUrl = await getSignedUrl('artifacts', s.screenshotPath)
      }
      return {
        url: s.url ?? '',
        action: s.action ?? '',
        observation: s.observation ?? '',
        screenshotUrl,
      }
    }),
  )

  const result = await generateDocumentation({
    featureName: run.featureName,
    goal: run.goal,
    startUrl: run.startUrl,
    steps: stepSummaries,
    questions: questions.map((q) => ({ question: q.question, answer: q.answer })),
    projectContext: options?.projectContext,
    tableOfContents: options?.tableOfContents,
    existingPageSummaries: options?.existingPageSummaries,
  })

  await deps.incrementTokenUsage(runId, result.usage.inputTokens + result.usage.outputTokens)

  return docRepo.upsertDoc({
    runId,
    docPageId: run.docPageId ?? undefined,
    markdownContent: result.markdown,
    jsonContent: result.json,
  })
}
