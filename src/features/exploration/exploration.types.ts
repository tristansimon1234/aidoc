export interface StepSummary {
  url: string
  action: string
  observation: string
}

export interface StepData {
  url: string
  title: string
  visibleElements: string
}

export interface Question {
  question: string
  answer: string | null
}

export interface RunContext {
  goal: string
  featureName: string
  stepHistory: StepSummary[]
  currentStep: StepData
  questionHistory: Question[]
}

export type AgentDecision =
  | { action: 'continue'; nextAction: string }
  | { action: 'ask'; question: string }
  | { action: 'blocked'; reason: string }
  | { action: 'finish'; summary: string }
