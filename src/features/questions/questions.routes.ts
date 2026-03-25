import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import { AnswerQuestionSchema, QuestionParamsSchema } from './questions.schema.js'
import * as questionsService from './questions.service.js'

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
        const question = await questionsService.answerQuestion(params.data.qid, body.data.answer)
        res.status(200).json(question)
      } catch (err) {
        next(err)
      }
    })()
  },
)
