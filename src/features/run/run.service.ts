import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { Run, RunStep, CreateRunInput } from './run.types.js'
import * as runRepo from './run.repository.js'
import { executeOneStep, type RunDeps, type StepResult } from '../exploration/exploration.service.js'
import * as questionRepo from '../../features/questions/questions.repository.js'

function buildRunDeps(): RunDeps {
  return {
    findRunById: runRepo.findRunById,
    updateRunStatus: runRepo.updateRunStatus,
    incrementTokenUsage: runRepo.incrementTokenUsage,
    setBrowserbaseSessionId: runRepo.setBrowserbaseSessionId,
    createRunStep: runRepo.createRunStep,
    findStepsByRunId: runRepo.findStepsByRunId,
    findQuestionsByRunId: (runId) =>
      questionRepo.findQuestionsByRunId(runId).then((qs) =>
        qs.map((q) => ({ question: q.question, answer: q.answer })),
      ),
    createQuestion: questionRepo.createQuestion,
  }
}

export async function createRun(input: CreateRunInput): Promise<Run> {
  return runRepo.createRun(input)
}

export async function runNextStep(id: string): Promise<StepResult> {
  const run = await runRepo.findRunById(id)
  if (!run) throw new NotFoundError('Run')
  if (run.status !== 'pending' && run.status !== 'running') {
    throw new NotFoundError('Run is not in a runnable state')
  }
  return executeOneStep(id, buildRunDeps())
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
