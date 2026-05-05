import { NotFoundError, AppError } from '../../shared/middleware/error.middleware.js'
import type { Project, CreateProjectInput, UpdateProjectInput } from './project.types.js'
import * as projectRepo from './project.repository.js'
import { findMember } from '../team/team.repository.js'
import { getSignedUrl } from '../../shared/db/storage.repository.js'

// Logo URLs are always re-signed on read. We extract the storage path
// from whatever's stored (public URL, expired signed URL, fresh signed
// URL — all share the same path segment) and mint a new signed URL each
// time the project is fetched. This means:
//   - Old public URLs that 401 (artifacts bucket not actually public) heal.
//   - Signed URLs never go stale: the upload-time URL is just a snapshot;
//     real reads always come through getProject / listProjects, so any
//     in-flight URL outlives the request.
// External URLs (anything not under /storage/v1/object/.../artifacts/)
// pass through unchanged.
const ARTIFACTS_PATH_RE = /\/storage\/v1\/object\/(?:public|sign)\/artifacts\/([^?]+)/

// In-process cache for resigned logo URLs. Supabase signed URLs default
// to 1h validity; we cache for 50min to leave a 10min cushion before
// they actually expire. Each Vercel cold start gets its own cache —
// fine, the savings are within a single function invocation's worth of
// project reads (listProjects + getProject + activity feed all hit the
// same project rows).
const SIGNED_URL_TTL_MS = 50 * 60 * 1000
const logoCache = new Map<string, { url: string; expiresAt: number }>()

async function resignLogoUrl(logoUrl: string | null | undefined): Promise<string | null> {
  if (!logoUrl) return null
  const m = logoUrl.match(ARTIFACTS_PATH_RE)
  if (!m || !m[1]) return logoUrl
  const path = decodeURIComponent(m[1])
  const cached = logoCache.get(path)
  if (cached && cached.expiresAt > Date.now()) return cached.url
  const fresh = await getSignedUrl('artifacts', path)
  if (fresh) logoCache.set(path, { url: fresh, expiresAt: Date.now() + SIGNED_URL_TTL_MS })
  return fresh ?? logoUrl
}

async function hydrateProjectLogo(project: Project): Promise<Project> {
  if (!project.design?.logoUrl) return project
  const signed = await resignLogoUrl(project.design.logoUrl)
  if (signed === project.design.logoUrl) return project
  return { ...project, design: { ...project.design, logoUrl: signed ?? undefined } }
}

export async function assertTeamMembership(teamId: string, userId: string): Promise<void> {
  const member = await findMember(teamId, userId)
  if (!member) throw new AppError('Forbidden', 'FORBIDDEN', 403)
}

async function assertAccess(project: Project, userId: string): Promise<void> {
  await assertTeamMembership(project.teamId, userId)
}

/** Resolve a project and assert the caller has access to it via team
 *  membership. Returns the project so callers can use it directly.
 *  Throws 404 (project) or 403 (forbidden) — callers should not care
 *  which, treat both as "no access". */
export async function assertProjectAccess(projectId: string, userId: string): Promise<Project> {
  const project = await projectRepo.findProjectById(projectId)
  if (!project) throw new NotFoundError('Project')
  await assertAccess(project, userId)
  return project
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
