export interface StepSummary {
  url: string
  action: string
  observation: string
  screenshotUrl: string | null
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

export interface StepEvent {
  type: 'step' | 'status' | 'done' | 'error' | 'blocked' | 'live' | 'summary' | 'cancelled'
  step?: AgentActionRecord
  stepIndex?: number
  message?: string
  completed?: boolean
  liveUrl?: string
  summary?: ExplorationSummary
}

export interface ExplorationSection {
  url: string
  label: string
  status: 'documented' | 'partial' | 'blocked' | 'skipped'
  stepCount: number
}

export interface ExplorationBlocker {
  type: 'credentials' | 'access' | 'error' | 'other'
  description: string
  section: string
  actionLabel: string
}

export interface ExplorationSummary {
  sections: ExplorationSection[]
  blockers: ExplorationBlocker[]
  agentMessage: string
}
