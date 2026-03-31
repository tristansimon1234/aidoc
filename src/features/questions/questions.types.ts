export interface RunQuestion {
  id: string
  runId: string
  stepId: string | null
  question: string
  answer: string | null
  answeredAt: Date | null
  createdAt: Date
}

export interface AnswerQuestionInput {
  answer: string
}
