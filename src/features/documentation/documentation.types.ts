export interface GeneratedDoc {
  id: string
  runId: string
  markdownContent: string | null
  jsonContent: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

export type StepConfidence = 'high' | 'medium' | 'low'

export interface DocStepAssessment {
  stepIndex: number
  confidence: StepConfidence
  note: string | null
}

export interface DocGap {
  area: string
  reason: string
  severity: 'major' | 'minor'
}

export interface DocNextStep {
  suggestion: string
  reason: string
  priority: 'high' | 'medium' | 'low'
}

export interface StructuralSuggestion {
  type: 'move' | 'merge' | 'split' | 'rename' | 'new'
  targetSlug?: string
  details: string
  suggestedTitle?: string
  suggestedParentSlug?: string
}

export interface DocSelfAssessment {
  overallCompleteness: number
  stepAssessments: DocStepAssessment[]
  gaps: DocGap[]
  nextSteps: DocNextStep[]
  structuralSuggestions?: StructuralSuggestion[]
}

export interface DocJsonSummary {
  featureName: string
  totalSteps: number
  keyPages: string[]
  userActions: string[]
  screenshots: number
  selfAssessment: DocSelfAssessment
}
