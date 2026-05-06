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

export interface ProjectResource {
  type: 'url' | 'file' | 'note'
  label: string
  value: string
}

export interface ProjectDesign {
  accentColor: string
  bgColor: string
  textColor: string
  font: string
  logoUrl?: string
  widgetPosition?: string
  widgetGreeting?: string
  /** Secondary brand accent. Used in marketing videos for two-tone
   *  gradients / variant chips. Optional — falls back to a darker shade
   *  of `accentColor` when missing. */
  accentSecondary?: string
  /** Corner radius (px) used by marketing-video primitives + the Cta
   *  button. Defaults to 14 in the renderer. */
  radius?: number
}

export interface Project {
  id: string
  userId: string    // kept as audit / creator until cleanup migration
  teamId: string    // billing + access control entity
  name: string
  baseUrl: string
  description: string | null
  context: ProjectContext | null
  credentials: ProjectCredential[] | null
  resources: ProjectResource[] | null
  discoveredContext: DiscoveredContext | null
  design: ProjectDesign | null
  widgetApiKey: string | null
  widgetEnabled: boolean
  mcpApiKey: string | null
  mcpEnabled: boolean
  walkthroughEnabled: boolean
  publicDocsChatEnabled: boolean
  archivedAt: Date | null
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
  resources?: ProjectResource[]
  discoveredContext?: DiscoveredContext
  design?: ProjectDesign
  walkthroughEnabled?: boolean
  publicDocsChatEnabled?: boolean
  archivedAt?: Date | null
}
