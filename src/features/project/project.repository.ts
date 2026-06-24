import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { Project, CreateProjectInput, UpdateProjectInput, ProjectCredential, ProjectResource, ProjectContext, DiscoveredContext, ProjectDesign } from './project.types.js'

interface ProjectRow {
  id: string
  user_id: string
  team_id: string
  name: string
  base_url: string
  description: string | null
  context: ProjectContext | null
  credentials: ProjectCredential[] | null
  resources: ProjectResource[] | null
  discovered_context: DiscoveredContext | null
  design: ProjectDesign | null
  widget_api_key: string | null
  widget_enabled: boolean
  mcp_api_key: string | null
  mcp_enabled: boolean
  walkthrough_enabled: boolean
  public_docs_chat_enabled: boolean
  archived_at: string | null
  created_at: string
  updated_at: string
}

function mapToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    userId: row.user_id,
    teamId: row.team_id,
    name: row.name,
    baseUrl: row.base_url,
    description: row.description,
    context: row.context,
    credentials: row.credentials,
    resources: row.resources,
    discoveredContext: row.discovered_context,
    design: row.design,
    widgetApiKey: row.widget_api_key,
    widgetEnabled: row.widget_enabled,
    mcpApiKey: row.mcp_api_key,
    mcpEnabled: row.mcp_enabled,
    walkthroughEnabled: row.walkthrough_enabled,
    publicDocsChatEnabled: row.public_docs_chat_enabled ?? false,
    archivedAt: row.archived_at ? new Date(row.archived_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export async function createProject(userId: string, teamId: string, input: CreateProjectInput): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .insert({
      user_id: userId,
      team_id: teamId,
      name: input.name,
      base_url: input.baseUrl,
      description: input.description ?? null,
      context: input.context ?? null,
      credentials: input.credentials ?? null,
      design: input.design ?? null,
    })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToProject(data as ProjectRow)
}

export async function findProjectById(id: string): Promise<Project | null> {
  const { data, error } = await supabase.from('projects').select('*').eq('id', id).single()
  if (error && error.code === 'PGRST116') return null
  if (error) throw new DatabaseError(error.message)
  return data ? mapToProject(data as ProjectRow) : null
}

/** List projects visible to a user across all their teams — RLS filters down
 *  to just the rows they have access to via team_members. Hard-capped to
 *  keep the response bounded until we add cursor pagination. */
export async function listProjectsForUser(_userId: string, teamId?: string): Promise<Project[]> {
  let query = supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)
  if (teamId) query = query.eq('team_id', teamId)
  const { data, error } = await query
  if (error) throw new DatabaseError(error.message)
  return (data as ProjectRow[]).map(mapToProject)
}

export async function updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.name !== undefined) updates.name = input.name
  if (input.baseUrl !== undefined) updates.base_url = input.baseUrl
  if (input.description !== undefined) updates.description = input.description
  if (input.context !== undefined) updates.context = input.context
  if (input.credentials !== undefined) updates.credentials = input.credentials
  if (input.resources !== undefined) updates.resources = input.resources
  if (input.discoveredContext !== undefined) updates.discovered_context = input.discoveredContext
  if (input.design !== undefined) updates.design = input.design
  if (input.walkthroughEnabled !== undefined) updates.walkthrough_enabled = input.walkthroughEnabled
  if (input.publicDocsChatEnabled !== undefined) updates.public_docs_chat_enabled = input.publicDocsChatEnabled
  if (input.archivedAt !== undefined) updates.archived_at = input.archivedAt ? input.archivedAt.toISOString() : null

  const { data, error } = await supabase
    .from('projects')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToProject(data as ProjectRow)
}

export async function updateProjectTeam(id: string, teamId: string): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .update({ team_id: teamId, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToProject(data as ProjectRow)
}

export async function updateDiscoveredContext(id: string, context: DiscoveredContext): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({ discovered_context: context as unknown as Record<string, unknown>, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new DatabaseError(error.message)
}

export async function findProjectByWidgetKey(widgetApiKey: string): Promise<Project | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('widget_api_key', widgetApiKey)
    .eq('widget_enabled', true)
    .single()
  if (error && error.code === 'PGRST116') return null
  if (error) throw new DatabaseError(error.message)
  return data ? mapToProject(data as ProjectRow) : null
}

export async function setWidgetApiKey(id: string, apiKey: string): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .update({ widget_api_key: apiKey, widget_enabled: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToProject(data as ProjectRow)
}

export async function disableWidget(id: string): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .update({ widget_enabled: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToProject(data as ProjectRow)
}

export async function findProjectByMcpKey(mcpApiKey: string): Promise<Project | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('mcp_api_key', mcpApiKey)
    .eq('mcp_enabled', true)
    .single()
  if (error && error.code === 'PGRST116') return null
  if (error) throw new DatabaseError(error.message)
  return data ? mapToProject(data as ProjectRow) : null
}

export async function setMcpApiKey(id: string, apiKey: string): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .update({ mcp_api_key: apiKey, mcp_enabled: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToProject(data as ProjectRow)
}

export async function disableMcp(id: string): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .update({ mcp_enabled: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToProject(data as ProjectRow)
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase.from('projects').delete().eq('id', id)
  if (error) throw new DatabaseError(error.message)
}
