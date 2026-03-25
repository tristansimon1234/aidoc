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
  context: string | null
  credentials: ProjectCredential[] | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateProjectInput {
  name: string
  baseUrl: string
  description?: string
  context?: string
  credentials?: ProjectCredential[]
}

export interface UpdateProjectInput {
  name?: string
  baseUrl?: string
  description?: string
  context?: string
  credentials?: ProjectCredential[]
}
