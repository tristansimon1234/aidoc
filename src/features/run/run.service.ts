import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { Run, RunStep, CreateRunInput } from './run.types.js'
import * as runRepo from './run.repository.js'
import { executeRun, type RunDeps } from '../exploration/exploration.service.js'
import * as questionRepo from '../../features/questions/questions.repository.js'

function buildRunDeps(): RunDeps {
  return {
    findRunById: runRepo.findRunById,
    updateRunStatus: runRepo.updateRunStatus,
    incrementTokenUsage: runRepo.incrementTokenUsage,
    createRunStep: runRepo.createRunStep,
    findQuestionsByRunId: (runId) =>
      questionRepo.findQuestionsByRunId(runId).then((qs) =>
        qs.map((q) => ({ question: q.question, answer: q.answer })),
      ),
    createQuestion: questionRepo.createQuestion,
  }
}

export async function createAndStartRun(input: CreateRunInput): Promise<Run> {
  const run = await runRepo.createRun(input)

  // Fire-and-forget: launch exploration in background
  // The run status updates happen inside executeRun
  executeRun(run.id, buildRunDeps()).catch((err) => {
    console.error(`Background run ${run.id} failed:`, err)
  })

  return run
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
