import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { AppError, NotFoundError, ValidationError } from '../../shared/middleware/error.middleware.js'
import { AnswerQuestionSchema, QuestionParamsSchema } from './questions.schema.js'
import * as questionsService from './questions.service.js'
import * as questionsRepo from './questions.repository.js'
import { assertRunAccess } from '../run/run.service.js'

export const questionsRouter = Router()

questionsRouter.post(
  '/:id/questions/:qid/answer',
  (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const params = QuestionParamsSchema.safeParse(req.params)
        if (!params.success) throw new ValidationError(params.error.flatten())
        const body = AnswerQuestionSchema.safeParse(req.body)
        if (!body.success) throw new ValidationError(body.error.flatten())
        const userId = (req as Request & { userId?: string }).userId
        if (!userId) throw new AppError('Unauthorized', 'UNAUTHORIZED', 401)

        await assertRunAccess(params.data.id, userId)
        // Defense-in-depth: caller can't combine their own runId with a
        // question that lives on another run.
        const existing = await questionsRepo.findQuestionById(params.data.qid)
        if (!existing || existing.runId !== params.data.id) {
          throw new NotFoundError('Question')
        }

        const question = await questionsService.answerQuestion(params.data.qid, body.data.answer)
        res.status(200).json(question)
      } catch (err) {
        next(err)
      }
    })()
  },
)
