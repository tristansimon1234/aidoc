import type { StepSummary } from '../src/features/exploration/exploration.types.js'

export interface EvalFixture {
  featureName: string
  goal: string
  startUrl: string
  steps: StepSummary[]
  projectContext?: string
  runStatus: string
  questions?: { question: string; answer: string | null }[]
}

export interface EvalCriteria {
  mustMention: string[]
  mustNotMention?: string[]
  minSections: number
  maxSections?: number
  language: string
  minCompleteness: number
}

export interface HeuristicScore {
  sections: number
  screenshots: number
  length: number
  mentionsHit: string[]
  mentionsMissed: string[]
  hallucinations: string[]
  completeness: number
  languageMatch: boolean
  jsonParsed: boolean
}

export interface LlmJudgeScore {
  accuracy: number
  structure: number
  clarity: number
  noHallucination: number
  overall: number
  reasoning: string
}

export interface EvalScore {
  fixture: string
  heuristics: HeuristicScore
  llmJudge: LlmJudgeScore
  pass: boolean
}
