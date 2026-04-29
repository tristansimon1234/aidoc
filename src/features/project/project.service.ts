import { NotFoundError, AppError } from '../../shared/middleware/error.middleware.js'
import type { Project, CreateProjectInput, UpdateProjectInput } from './project.types.js'
import * as projectRepo from './project.repository.js'
import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import { getSignedUrl } from '../../shared/db/storage.repository.js'

// Old logos were saved as `getPublicUrl()` strings. Those 401 when the
// artifacts bucket isn't actually public on the user's Supabase instance
// (the make-public migration didn't run, or RLS was added later). Detect
// the public-URL shape, extract the storage path, and return a fresh
// signed URL (1 year). Already-signed URLs and external URLs pass through.
const ARTIFACTS_PATH_RE = /\/storage\/v1\/object\/(?:public|sign)\/artifacts\/([^?]+)/

async function resignLogoUrl(logoUrl: string | null | undefined): Promise<string | null> {
  if (!logoUrl) return null
  // Already a signed URL with a token? Leave it alone.
  if (logoUrl.includes('/storage/v1/object/sign/') && logoUrl.includes('token=')) return logoUrl
  const m = logoUrl.match(ARTIFACTS_PATH_RE)
  if (!m || !m[1]) return logoUrl
  const fresh = await getSignedUrl('artifacts', decodeURIComponent(m[1]))
  return fresh ?? logoUrl
}

async function hydrateProjectLogo(project: Project): Promise<Project> {
  if (!project.design?.logoUrl) return project
  const signed = await resignLogoUrl(project.design.logoUrl)
  if (signed === project.design.logoUrl) return project
  return { ...project, design: { ...project.design, logoUrl: signed ?? undefined } }
}

async function assertTeamMembership(teamId: string, userId: string): Promise<void> {
  const { data, error } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  if (!data) throw new AppError('Forbidden', 'FORBIDDEN', 403)
}

async function assertAccess(project: Project, userId: string): Promise<void> {
  await assertTeamMembership(project.teamId, userId)
}

export async function createProject(userId: string, teamId: string, input: CreateProjectInput): Promise<Project> {
  await assertTeamMembership(teamId, userId)
  const project = await projectRepo.createProject(userId, teamId, input)

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
  if (userId) await assertAccess(project, userId)
  return hydrateProjectLogo(project)
}

export async function listProjects(userId: string, teamId?: string): Promise<Project[]> {
  if (teamId) await assertTeamMembership(teamId, userId)
  const projects = await projectRepo.listProjectsForUser(userId, teamId)
  return Promise.all(projects.map(hydrateProjectLogo))
}

export async function updateProject(id: string, userId: string, input: UpdateProjectInput): Promise<Project> {
  const project = await projectRepo.findProjectById(id)
  if (!project) throw new NotFoundError('Project')
  await assertAccess(project, userId)
  return projectRepo.updateProject(id, input)
}

export async function deleteProject(id: string, userId: string): Promise<void> {
  const project = await projectRepo.findProjectById(id)
  if (!project) throw new NotFoundError('Project')
  await assertAccess(project, userId)
  return projectRepo.deleteProject(id)
}

/**
 * Transfer a project from its current workspace to another one the
 * caller also owns. Requires owner role on BOTH teams — lets us move
 * a project from a personal workspace into a team for collaboration,
 * or consolidate between teams, without re-creating pages + runs +
 * embeddings (everything is FK'd to the project id, so the team_id
 * column flip is sufficient).
 */
export async function transferProject(id: string, userId: string, destTeamId: string): Promise<Project> {
  const project = await projectRepo.findProjectById(id)
  if (!project) throw new NotFoundError('Project')
  if (project.teamId === destTeamId) {
    throw new AppError('Project is already in this workspace.', 'ALREADY_IN_TEAM', 400)
  }

  const { findMember } = await import('../team/team.repository.js')
  const [sourceRole, destRole] = await Promise.all([
    findMember(project.teamId, userId),
    findMember(destTeamId, userId),
  ])
  if (!sourceRole || sourceRole.role !== 'owner') {
    throw new AppError('You must be the owner of the current workspace to transfer it.', 'NOT_SOURCE_OWNER', 403)
  }
  if (!destRole) {
    throw new AppError('You are not a member of the destination workspace.', 'NOT_DEST_MEMBER', 403)
  }
  if (destRole.role !== 'owner') {
    throw new AppError('You must be the owner of the destination workspace to move projects into it.', 'NOT_DEST_OWNER', 403)
  }

  return projectRepo.updateProjectTeam(id, destTeamId)
}
