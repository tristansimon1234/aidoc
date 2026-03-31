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
}

export interface ReorderItem {
  id: string
  parentId: string | null
  sortOrder: number
}
