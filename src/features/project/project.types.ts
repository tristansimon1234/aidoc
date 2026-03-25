export interface Project {
  id: string
  userId: string
  name: string
  baseUrl: string
  description: string | null
  context: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateProjectInput {
  name: string
  baseUrl: string
  description?: string
  context?: string
}

export interface UpdateProjectInput {
  name?: string
  baseUrl?: string
  description?: string
  context?: string
}
