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

// --- Try Doc Report ---

export interface TryDocStepResult {
  stepIndex: number
  instruction: string
  action: string
  pageUrl: string | null
  status: 'pass' | 'fail' | 'ambiguous'
  issueType: 'doc' | 'product' | null
  detail: string
  screenshotPath: string | null
}

export interface TryDocFailure {
  stepIndex: number
  issueType: 'doc' | 'product'
  title: string
  description: string
  severity: 'critical' | 'major' | 'minor'
  suggestion: string
}

export interface TryDocInsight {
  category: 'friction' | 'missing-feedback' | 'unnecessary-step' | 'doc-behavior-mismatch' | 'implicit-assumption'
  description: string
  stepIndex: number | null
  severity: 'high' | 'medium' | 'low'
}

export interface TryDocRecommendation {
  type: 'fix-doc' | 'fix-product' | 'improve-ux'
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
}

export interface TryDocReport {
  version: number
  pageId: string
  pageTitle: string
  executedAt: string
  summary: {
    totalSteps: number
    passed: number
    failed: number
    ambiguous: number
    overallVerdict: 'pass' | 'fail' | 'partial'
  }
  steps: TryDocStepResult[]
  failures: TryDocFailure[]
  docIssues: {
    clarityScore: number
    missingSections: string[]
    ambiguousInstructions: string[]
    implicitAssumptions: string[]
  }
  uxInsights: TryDocInsight[]
  recommendations: TryDocRecommendation[]
  scores: {
    docQuality: number
    testPassRate: number
    uxClarity: number
  }
}
