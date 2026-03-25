import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { Run, RunStep, CreateRunInput } from './run.types.js'
import * as runRepo from './run.repository.js'
import { exploreRun, type RunDeps } from '../exploration/exploration.service.js'
import type { ExplorationResult } from '../exploration/exploration.types.js'
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

export async function explore(id: string): Promise<ExplorationResult> {
  const run = await runRepo.findRunById(id)
  if (!run) throw new NotFoundError('Run')
  if (run.status !== 'pending' && run.status !== 'blocked') {
    throw new NotFoundError('Run is not in a startable state')
  }

  const result = await exploreRun(id, buildRunDeps())

  // If exploration completed, ask a question if needed
  if (result.needsQuestion && result.question) {
    await questionRepo.createQuestion({
      runId: id,
      stepId: '', // no specific step
      question: result.question,
    })
  }

  return result
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
