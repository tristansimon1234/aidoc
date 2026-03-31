import { z } from 'zod'

export const AnswerQuestionSchema = z.object({
  answer: z.string().min(1, 'Answer is required'),
})

export const QuestionParamsSchema = z.object({
  id: z.string().uuid(),
  qid: z.string().uuid(),
})
