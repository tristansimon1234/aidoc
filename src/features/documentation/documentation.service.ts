import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import * as docRepo from './documentation.repository.js'
import { generateDocumentation } from './documentation.generator.js'
import type { GeneratedDoc } from './documentation.types.js'

export interface DocDeps {
  findRunById: (id: string) => Promise<{
    featureName: string
    goal: string
    tokenUsage: number
  } | null>
  findStepsByRunId: (runId: string) => Promise<
    { url: string | null; action: string | null; observation: string | null }[]
  >
  incrementTokenUsage: (id: string, tokens: number) => Promise<void>
}

export async function getDocByRunId(runId: string): Promise<GeneratedDoc> {
  const doc = await docRepo.findDocByRunId(runId)
  if (!doc) throw new NotFoundError('Document')
  return doc
}

export async function generateAndSaveDoc(
  runId: string,
  deps: DocDeps,
): Promise<GeneratedDoc> {
  const run = await deps.findRunById(runId)
  if (!run) throw new NotFoundError('Run')

  const steps = await deps.findStepsByRunId(runId)
  const stepSummaries = steps.map((s) => ({
    url: s.url ?? '',
    action: s.action ?? '',
    observation: s.observation ?? '',
  }))

  const result = await generateDocumentation({
    featureName: run.featureName,
    goal: run.goal,
    steps: stepSummaries,
  })

  await deps.incrementTokenUsage(runId, result.usage.inputTokens + result.usage.outputTokens)

  return docRepo.upsertDoc({
    runId,
    markdownContent: result.markdown,
    jsonContent: result.json,
  })
}
