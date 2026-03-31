import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { Project, CreateProjectInput, UpdateProjectInput } from './project.types.js'
import * as projectRepo from './project.repository.js'

export async function createProject(userId: string, input: CreateProjectInput): Promise<Project> {
  return projectRepo.createProject(userId, input)
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
