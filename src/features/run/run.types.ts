export type RunStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed'

export interface Run {
  id: string
  featureName: string
  startUrl: string
  goal: string
  status: RunStatus
  tokenUsage: number
  browserbaseSessionId: string | null
  docPageId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface RunStep {
  id: string
  runId: string
  stepIndex: number
  url: string | null
  title: string | null
  action: string | null
  observation: string | null
  screenshotPath: string | null
  status: 'completed' | 'blocked' | 'skipped'
  createdAt: Date
}

export interface CreateRunInput {
  featureName: string
  startUrl: string
  goal: string
  docPageId?: string
}
