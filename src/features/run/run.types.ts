export type RunStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed'

/** 'doc' = standard recording → documentation flow (has a linked doc_page).
 *  'marketing-only' = standalone marketing-video run created at the project
 *  level. No doc_page; the script is generated from `brief` instead. */
export type RunKind = 'doc' | 'marketing-only'

export interface Run {
  id: string
  featureName: string
  startUrl: string
  goal: string
  status: RunStatus
  tokenUsage: number
  browserbaseSessionId: string | null
  docPageId: string | null
  projectId: string | null
  kind: RunKind
  brief: string | null
  summaryJson: Record<string, unknown> | null
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
  /** Set to 'marketing-only' when creating a standalone marketing-video run
   *  at the project level (no doc page). Defaults to 'doc'. */
  kind?: RunKind
  /** Required when `kind === 'marketing-only'`. Free-text product description
   *  used as the input to the marketing-script generator in lieu of a doc
   *  page's content. */
  brief?: string
  /** Project the run belongs to. Required for marketing-only runs (no
   *  page to derive it from); ignored for `kind='doc'` runs which resolve
   *  it via the linked page. */
  projectId?: string
}
