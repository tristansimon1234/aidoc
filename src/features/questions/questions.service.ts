import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { RunQuestion } from './questions.types.js'
import * as questionRepo from './questions.repository.js'

export async function answerQuestion(questionId: string, answer: string): Promise<RunQuestion> {
  const question = await questionRepo.findQuestionById(questionId)
  if (!question) throw new NotFoundError('Question')
  return questionRepo.answerQuestion(questionId, answer)
}

export async function getQuestionsByRunId(runId: string): Promise<RunQuestion[]> {
  return questionRepo.findQuestionsByRunId(runId)
}
