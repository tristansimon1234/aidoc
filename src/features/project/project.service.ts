import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { Project, CreateProjectInput, UpdateProjectInput } from './project.types.js'
import * as projectRepo from './project.repository.js'

export async function createProject(userId: string, input: CreateProjectInput): Promise<Project> {
  const project = await projectRepo.createProject(userId, input)

  // Auto-create a "Getting Started" page so the project isn't empty
  const { createPage } = await import('../page/page.repository.js')
  await createPage({
    projectId: project.id,
    title: 'Getting Started',
    slug: 'getting-started',
    startUrl: input.baseUrl,
    goal: `Document how to get started with ${input.name}`,
    sortOrder: 0,
  })

  return project
}

export async function getProject(id: string): Promise<Project> {
  const project = await projectRepo.findProjectById(id)
  if (!project) throw new NotFoundError('Project')
  return project
}

export async function listProjects(userId: string): Promise<Project[]> {
  return projectRepo.listProjectsByUserId(userId)
}

export async function updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
  const project = await projectRepo.findProjectById(id)
  if (!project) throw new NotFoundError('Project')
  return projectRepo.updateProject(id, input)
}

export async function deleteProject(id: string): Promise<void> {
  const project = await projectRepo.findProjectById(id)
  if (!project) throw new NotFoundError('Project')
  return projectRepo.deleteProject(id)
}
