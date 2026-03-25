import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { Run, RunStep, CreateRunInput } from './run.types.js'
import * as runRepo from './run.repository.js'
import { exploreRun, type RunDeps } from '../exploration/exploration.service.js'
import type { StepEvent } from '../exploration/exploration.types.js'
import * as questionRepo from '../../features/questions/questions.repository.js'
import { generateAndSaveDoc } from '../documentation/documentation.service.js'
import type { DocDeps } from '../documentation/documentation.service.js'
import type { GeneratedDoc } from '../documentation/documentation.types.js'

function buildRunDeps(): RunDeps {
  return {
    findRunById: runRepo.findRunById,
    updateRunStatus: runRepo.updateRunStatus,
    incrementTokenUsage: runRepo.incrementTokenUsage,
    setBrowserbaseSessionId: runRepo.setBrowserbaseSessionId,
    createRunStep: runRepo.createRunStep,
    countSteps: runRepo.countStepsByRunId,
  }
}

function buildDocDeps(): DocDeps {
  return {
    findRunById: runRepo.findRunById,
    findStepsByRunId: runRepo.findStepsByRunId,
    incrementTokenUsage: runRepo.incrementTokenUsage,
  }
}

export async function createRun(input: CreateRunInput): Promise<Run> {
  return runRepo.createRun(input)
}

export async function exploreWithEvents(
  id: string,
  onEvent: (event: StepEvent) => void,
  additionalContext?: string,
): Promise<void> {
  const run = await runRepo.findRunById(id)
  if (!run) throw new NotFoundError('Run')

  if (run.status !== 'pending' && run.status !== 'blocked' && run.status !== 'failed') {
    throw new NotFoundError('Run is not in an explorable state')
  }

  await exploreRun(id, buildRunDeps(), {
    additionalContext,
    onEvent: (event) => {
      onEvent(event)

      // Save question to DB when blocked
      if (event.type === 'blocked' && event.message) {
        questionRepo.createQuestion({
          runId: id,
          stepId: '',
          question: event.message,
        }).catch((err) => console.error('Failed to save question:', err))
      }
    },
  })
}

export async function generateDoc(id: string): Promise<GeneratedDoc> {
  const run = await runRepo.findRunById(id)
  if (!run) throw new NotFoundError('Run')
  return generateAndSaveDoc(id, buildDocDeps())
}

export async function getRun(id: string): Promise<Run> {
  const run = await runRepo.findRunById(id)
  if (!run) throw new NotFoundError('Run')
  return run
}

export async function listRuns(): Promise<Run[]> {
  return runRepo.listRuns()
}

export async function getRunSteps(runId: string): Promise<RunStep[]> {
  const run = await runRepo.findRunById(runId)
  if (!run) throw new NotFoundError('Run')
  return runRepo.findStepsByRunId(runId)
}

export async function getQuestions(runId: string): Promise<{ id: string; question: string; answer: string | null }[]> {
  const questions = await questionRepo.findQuestionsByRunId(runId)
  return questions.map((q) => ({ id: q.id, question: q.question, answer: q.answer }))
}
