export interface StepSummary {
  url: string
  action: string
  observation: string
}

export interface ExplorationResult {
  completed: boolean
  message: string
  actions: AgentActionRecord[]
  needsQuestion: boolean
  question: string | null
}

export interface AgentActionRecord {
  type: string
  action: string | null
  pageUrl: string | null
  reasoning: string | null
}
