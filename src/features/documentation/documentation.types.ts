export interface GeneratedDoc {
  id: string
  runId: string
  markdownContent: string | null
  jsonContent: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

export interface DocJsonSummary {
  featureName: string
  totalSteps: number
  keyPages: string[]
  userActions: string[]
  blockers: string[]
}
