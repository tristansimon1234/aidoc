import { NotFoundError, AppError } from '../../shared/middleware/error.middleware.js'
import type { Project, CreateProjectInput, UpdateProjectInput } from './project.types.js'
import * as projectRepo from './project.repository.js'
import * as profileRepo from '../profile/profile.repository.js'

function assertOwnership(project: Project, userId: string): void {
  if (project.userId !== userId) throw new AppError('Forbidden', 'FORBIDDEN', 403)
}

export async function createProject(userId: string, input: CreateProjectInput): Promise<Project> {
  // Inherit user's preferred language when the caller didn't pick one
  let language = input.language
  if (!language) {
    const profile = await profileRepo.findProfileById(userId)
    language = profile?.preferredLanguage
  }
  const project = await projectRepo.createProject(userId, { ...input, language })

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

export async function getProject(id: string, userId?: string): Promise<Project> {
  const project = await projectRepo.findProjectById(id)
  if (!project) throw new NotFoundError('Project')
  if (userId) assertOwnership(project, userId)
  return project
}

export async function listProjects(userId: string): Promise<Project[]> {
  return projectRepo.listProjectsByUserId(userId)
}

export async function updateProject(id: string, userId: string, input: UpdateProjectInput): Promise<Project> {
  const project = await projectRepo.findProjectById(id)
  if (!project) throw new NotFoundError('Project')
  assertOwnership(project, userId)
  return projectRepo.updateProject(id, input)
}

export async function deleteProject(id: string, userId: string): Promise<void> {
  const project = await projectRepo.findProjectById(id)
  if (!project) throw new NotFoundError('Project')
  assertOwnership(project, userId)
  return projectRepo.deleteProject(id)
}
