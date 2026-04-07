export interface ProjectContext {
  audience: string
  workflow: string
  quirks: string
}

export interface ProjectCredential {
  label: string
  username: string
  password: string
}

export interface Project {
  id: string
  userId: string
  name: string
  baseUrl: string
  description: string | null
  context: ProjectContext | null
  credentials: ProjectCredential[] | null
  discoveredContext: DiscoveredContext | null
  createdAt: Date
  updatedAt: Date
}

export interface DiscoveredContext {
  lastUpdated: string
  siteStructure: string[]
  navigation: string[]
  terminology: Record<string, string>
  features: string[]
  summary: string
}

export interface CreateProjectInput {
  name: string
  baseUrl: string
  description?: string
  context?: ProjectContext
  credentials?: ProjectCredential[]
}

export interface UpdateProjectInput {
  name?: string
  baseUrl?: string
  description?: string
  context?: ProjectContext
  credentials?: ProjectCredential[]
  discoveredContext?: DiscoveredContext
}
