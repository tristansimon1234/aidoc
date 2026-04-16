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
  customPrompt: string | null
  briefing: PageBriefing | null
  status: PageStatus
  isPublic: boolean
  sortOrder: number
  createdAt: Date
  updatedAt: Date
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
