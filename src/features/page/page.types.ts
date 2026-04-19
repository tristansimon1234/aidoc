export type PageStatus = 'draft' | 'exploring' | 'published'

export type PageResourceType = 'url' | 'credential' | 'endpoint' | 'file' | 'note'

export interface PageResource {
  type: PageResourceType
  label: string
  value: string
}

export interface PageBriefing {
  objective: string
  knowledge: string
  resources: PageResource[]
}

export interface PageResourceWithContent extends PageResource {
  content?: string
  fileBuffer?: Buffer
  fileName?: string
}

export interface PageBriefingWithContent {
  objective: string
  knowledge: string
  resources: PageResourceWithContent[]
}

export interface DocPage {
  id: string
  projectId: string
  parentId: string | null
  title: string
  slug: string
  startUrl: string | null
  goal: string | null
  content: string | null
  /**
   * BlockNote document as JSON — lossless source of truth when present.
   * Null for legacy pages and freshly-generated pages until the editor
   * persists it on the first real user edit. `content` (markdown) stays
   * populated for public-docs rendering and RAG indexing.
   */
  contentBlocks: unknown
  customPrompt: string | null
  briefing: PageBriefing | null
  status: PageStatus
  isPublic: boolean
  sortOrder: number
  createdAt: Date
  updatedAt: Date
  /** Authenticated user who last saved this page via the editor. Null for
   *  AI-authored pages that have never been touched by a human, and for
   *  rows that predate the last_edited_by migration. */
  lastEditedBy: string | null
  lastEditedAt: Date | null
  /** Resolved on single-page GET (service layer). The list endpoint skips
   *  this enrichment to avoid an N+1 — tree views only need the timestamp. */
  lastEditedByName?: string | null
}

export interface DocPageTreeNode extends DocPage {
  children: DocPageTreeNode[]
}

export interface CreatePageInput {
  projectId: string
  parentId?: string
  title: string
  slug: string
  startUrl?: string
  goal?: string
  sortOrder?: number
}

export interface UpdatePageInput {
  title?: string
  slug?: string
  startUrl?: string
  goal?: string
  parentId?: string | null
  sortOrder?: number
  status?: PageStatus
  content?: string
  contentBlocks?: unknown
  customPrompt?: string
  briefing?: PageBriefing
  isPublic?: boolean
}

export interface ReorderItem {
  id: string
  parentId: string | null
  sortOrder: number
}

// --- Pre-flight verification ---

export type PreflightCheckCategory = 'url' | 'credentials' | 'file' | 'navigation' | 'prerequisite'
export type PreflightCheckStatus = 'ready' | 'missing' | 'warning'

export interface PreflightCheck {
  category: PreflightCheckCategory
  label: string
  status: PreflightCheckStatus
  detail: string
  resolution: string | null
}

export interface PreflightResult {
  ready: boolean
  testPlan: string
  estimatedSteps: number
  checks: PreflightCheck[]
}
