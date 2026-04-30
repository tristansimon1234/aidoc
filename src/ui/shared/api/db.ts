import { supabase } from './supabase.js'
import { getActiveTeamId, setActiveTeamId } from './client.js'
import type { DocPageDTO, RunDTO, GeneratedDocDTO, ProjectDTO, ProjectContextDTO, TryDocReportDTO, MarketingVideoSummaryDTO } from './client.js'

// Direct Supabase queries — bypass Vercel serverless

/**
 * Resolve the team to scope project queries to. Prefers the explicitly
 * selected team in localStorage (set by the AvatarMenu switcher or the
 * AcceptInvite flow), otherwise falls back to the user's personal team
 * and persists the choice so subsequent queries match.
 *
 * Returns null only when the user has no team membership at all — in
 * that case the caller should treat it as "no projects" rather than
 * unfiltered.
 */
async function resolveScopedTeamId(): Promise<string | null> {
  const cached = getActiveTeamId()
  if (cached) return cached
  const { data } = await supabase
    .from('team_members')
    .select('team_id, teams!inner(personal, created_at)')
    .order('created_at', { foreignTable: 'teams', ascending: true })
  type Row = { team_id: string; teams: { personal: boolean } | { personal: boolean }[] }
  const rows = (data ?? []) as Row[]
  const personal = rows.find((r) => {
    const t = Array.isArray(r.teams) ? r.teams[0] : r.teams
    return t?.personal
  })
  const pick = personal ?? rows[0]
  if (!pick) return null
  setActiveTeamId(pick.team_id)
  return pick.team_id
}

export async function fetchPageFull(pageId: string): Promise<{
  page: DocPageDTO
  latestRun: RunDTO | null
  doc: GeneratedDocDTO | null
}> {
  const [pageResult, runResult, docResult] = await Promise.all([
    supabase.from('doc_pages').select('*').eq('id', pageId).single(),
    supabase.from('runs').select('*').eq('doc_page_id', pageId).not('feature_name', 'like', '[Test]%').order('created_at', { ascending: false }).limit(1).single(),
    supabase.from('generated_docs').select('*').eq('doc_page_id', pageId).order('updated_at', { ascending: false }).limit(1).single(),
  ])

  if (pageResult.error) throw new Error(pageResult.error.message)

  const page = mapPage(pageResult.data)

  // Resolve creator + last-editor display names in one query so the page
  // header can render "Created by Alice · Edited by Bob 2h ago".
  const userIds = [page.createdBy, page.lastEditedBy].filter((id): id is string => typeof id === 'string')
  if (userIds.length > 0) {
    const uniqueIds = Array.from(new Set(userIds))
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .in('id', uniqueIds)
    const byId = new Map(
      (profiles ?? []).map((p) => {
        const r = p as { id: string; email: string | null; full_name: string | null }
        return [r.id, r.full_name ?? r.email ?? null] as const
      }),
    )
    if (page.createdBy) page.createdByName = byId.get(page.createdBy) ?? null
    if (page.lastEditedBy) page.lastEditedByName = byId.get(page.lastEditedBy) ?? null
  }

  const latestRun = runResult.data && !runResult.error ? mapRun(runResult.data) : null

  // If no page-level doc, try run-level
  let doc = docResult.data && !docResult.error ? mapDoc(docResult.data) : null
  if (!doc && latestRun) {
    const { data, error } = await supabase.from('generated_docs').select('*').eq('run_id', latestRun.id).single()
    if (data && !error) doc = mapDoc(data)
  }

  return { page, latestRun, doc }
}

export async function fetchProject(projectId: string): Promise<ProjectDTO> {
  const { data, error } = await supabase.from('projects').select('*').eq('id', projectId).single()
  if (error) throw new Error(error.message)
  return mapProject(data)
}

export async function fetchPageTree(projectId: string): Promise<DocPageDTO[]> {
  const { data, error } = await supabase
    .from('doc_pages')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []).map(mapPage)
}

export async function fetchProjects(): Promise<ProjectDTO[]> {
  // Scope to the active workspace — without this filter the RLS lets
  // members see projects from every team they belong to, so the same
  // project shows up in both the personal and the team workspace.
  const teamId = await resolveScopedTeamId()
  if (!teamId) return []
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('team_id', teamId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map(mapProject)
}

// --- Writes ---

export async function createProject(body: {
  name: string
  baseUrl: string
  description?: string
  context?: ProjectContextDTO
  credentials?: { label: string; username: string; password: string }[]
}): Promise<ProjectDTO> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Projects now require a team_id (NOT NULL since the teams migration).
  // Look up the user's personal team as the default landing spot — matches
  // the backend's resolveActiveTeam fallback behaviour.
  const { data: personal, error: teamErr } = await supabase
    .from('teams')
    .select('id')
    .eq('created_by', user.id)
    .eq('personal', true)
    .maybeSingle()
  if (teamErr) throw new Error(teamErr.message)
  if (!personal) throw new Error('No personal workspace — try signing out and back in')
  const teamId = (personal as { id: string }).id

  const { data, error } = await supabase
    .from('projects')
    .insert({
      user_id: user.id,
      team_id: teamId,
      name: body.name,
      base_url: body.baseUrl,
      description: body.description ?? null,
      context: body.context ?? null,
      credentials: body.credentials ?? null,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)

  // Auto-create Getting Started page
  await supabase.from('doc_pages').insert({
    project_id: data.id,
    title: 'Getting Started',
    slug: 'getting-started',
    start_url: body.baseUrl,
    goal: `Document how to get started with ${body.name}`,
    sort_order: 0,
  })

  return mapProject(data)
}

export async function updateProject(id: string, body: Record<string, unknown>): Promise<ProjectDTO> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) updates.base_url = body.baseUrl
  if (body.description !== undefined) updates.description = body.description
  if (body.context !== undefined) updates.context = body.context
  if (body.credentials !== undefined) updates.credentials = body.credentials
  if (body.resources !== undefined) updates.resources = body.resources
  if (body.discoveredContext !== undefined) updates.discovered_context = body.discoveredContext
  if (body.design !== undefined) updates.design = body.design
  if (body.walkthroughEnabled !== undefined) updates.walkthrough_enabled = body.walkthroughEnabled
  if (body.publicDocsChatEnabled !== undefined) updates.public_docs_chat_enabled = body.publicDocsChatEnabled
  if (body.archivedAt !== undefined) updates.archived_at = body.archivedAt

  const { data, error } = await supabase.from('projects').update(updates).eq('id', id).select('*').single()
  if (error) throw new Error(error.message)
  return mapProject(data)
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase.from('projects').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function createPage(
  projectId: string,
  body: { title: string; slug: string; parentId?: string; startUrl?: string; goal?: string },
): Promise<DocPageDTO> {
  const { data: authData } = await supabase.auth.getUser()
  const createdBy = authData.user?.id ?? null
  const { data, error } = await supabase
    .from('doc_pages')
    .insert({
      project_id: projectId,
      title: body.title,
      slug: body.slug,
      parent_id: body.parentId ?? null,
      start_url: body.startUrl ?? null,
      goal: body.goal ?? null,
      sort_order: 0,
      created_by: createdBy,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return mapPage(data)
}

export async function updatePage(
  _projectId: string,
  pageId: string,
  body: Record<string, unknown>,
): Promise<DocPageDTO> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.title !== undefined) updates.title = body.title
  if (body.slug !== undefined) updates.slug = body.slug
  if (body.startUrl !== undefined) updates.start_url = body.startUrl
  if (body.goal !== undefined) updates.goal = body.goal
  if (body.parentId !== undefined) updates.parent_id = body.parentId
  if (body.sortOrder !== undefined) updates.sort_order = body.sortOrder
  if (body.status !== undefined) updates.status = body.status
  if (body.content !== undefined) updates.content = body.content
  if (body.contentBlocks !== undefined) updates.content_blocks = body.contentBlocks
  if (body.customPrompt !== undefined) updates.custom_prompt = body.customPrompt
  if (body.briefing !== undefined) updates.briefing = body.briefing
  if (body.isPublic !== undefined) updates.is_public = body.isPublic

  // Stamp last_edited_* only when user-facing content actually changes.
  // Reorder / publish toggle shouldn't overwrite the "Edited by Alice"
  // indicator — it's about authorship, not metadata hygiene.
  const touchesContent =
    body.content !== undefined ||
    body.contentBlocks !== undefined ||
    body.title !== undefined ||
    body.briefing !== undefined
  if (touchesContent) {
    const { data: authData } = await supabase.auth.getUser()
    if (authData.user?.id) {
      updates.last_edited_by = authData.user.id
      updates.last_edited_at = new Date().toISOString()
    }
  }

  const { data, error } = await supabase.from('doc_pages').update(updates).eq('id', pageId).select('*').single()

  // If is_public column doesn't exist yet, retry without it
  if (error?.message?.includes('is_public')) {
    delete updates.is_public
    const retry = await supabase.from('doc_pages').update(updates).eq('id', pageId).select('*').single()
    if (retry.error) throw new Error(retry.error.message)
    return mapPage(retry.data)
  }

  if (error) throw new Error(error.message)
  return mapPage(data)
}

export async function deletePage(_projectId: string, pageId: string): Promise<void> {
  const { error } = await supabase.from('doc_pages').delete().eq('id', pageId)
  if (error) throw new Error(error.message)
}

export async function reorderPages(
  _projectId: string,
  items: { id: string; parentId: string | null; sortOrder: number }[],
): Promise<void> {
  // Fire all updates in parallel — much faster than sequential
  const now = new Date().toISOString()
  const promises = items.map((item) =>
    supabase
      .from('doc_pages')
      .update({ parent_id: item.parentId, sort_order: item.sortOrder, updated_at: now })
      .eq('id', item.id),
  )
  const results = await Promise.all(promises)
  const failed = results.find((r) => r.error)
  if (failed?.error) throw new Error(failed.error.message)
}

export async function fetchLatestTestReport(pageId: string): Promise<TryDocReportDTO | null> {
  const { data, error } = await supabase
    .from('runs')
    .select('summary_json')
    .eq('doc_page_id', pageId)
    .like('feature_name', '[Test]%')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !data) return null
  const summary = data.summary_json as Record<string, unknown> | null
  if (!summary?.tryDocReport) return null
  return summary.tryDocReport as TryDocReportDTO
}

/**
 * Marketing video summary lives on `runs.summary_json.marketingVideo`
 * (MVP storage; no dedicated table yet — see marketing-video.repository.ts).
 * Direct Supabase read avoids the Vercel cold-start that the equivalent
 * /runs/:id/marketing-view route incurs (~200-500ms saved per page mount).
 * Returns null when the run has no marketing video yet.
 */
export async function fetchMarketingVideo(runId: string): Promise<MarketingVideoSummaryDTO | null> {
  const { data, error } = await supabase
    .from('runs')
    .select('summary_json')
    .eq('id', runId)
    .single()
  if (error || !data) return null
  const summary = data.summary_json as Record<string, unknown> | null
  const mv = summary?.marketingVideo as MarketingVideoSummaryDTO | undefined
  return mv ?? null
}

/** Latest generated doc for a run — direct read of `generated_docs` so the
 *  PageView fallback path doesn't pay a serverless round-trip. RLS scopes
 *  to runs the user can see via project membership. */
export async function fetchRunDoc(runId: string): Promise<GeneratedDocDTO | null> {
  const { data, error } = await supabase
    .from('generated_docs')
    .select('*')
    .eq('run_id', runId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  return mapDoc(data)
}

// --- Helpers ---

function parseJsonbField(value: unknown): unknown {
  if (value == null) return null
  if (typeof value === 'object') return value
  if (typeof value === 'string') {
    try { return JSON.parse(value) }
    catch { return null }
  }
  return null
}

// --- snake_case → camelCase mappers ---

function mapProject(row: Record<string, unknown>): ProjectDTO {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    teamId: row.team_id as string,
    name: row.name as string,
    baseUrl: row.base_url as string,
    description: (row.description as string) ?? null,
    context: parseJsonbField(row.context) as ProjectDTO['context'] ?? null,
    discoveredContext: parseJsonbField(row.discovered_context) as ProjectDTO['discoveredContext'] ?? null,
    design: parseJsonbField(row.design) as ProjectDTO['design'] ?? null,
    credentials: parseJsonbField(row.credentials) as ProjectDTO['credentials'] ?? null,
    resources: parseJsonbField(row.resources) as ProjectDTO['resources'] ?? null,
    widgetApiKey: (row.widget_api_key as string) ?? null,
    widgetEnabled: (row.widget_enabled as boolean) ?? false,
    mcpApiKey: (row.mcp_api_key as string) ?? null,
    mcpEnabled: (row.mcp_enabled as boolean) ?? false,
    walkthroughEnabled: (row.walkthrough_enabled as boolean) ?? false,
    publicDocsChatEnabled: (row.public_docs_chat_enabled as boolean) ?? false,
    archivedAt: (row.archived_at as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

function mapPage(row: Record<string, unknown>): DocPageDTO {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    parentId: (row.parent_id as string) ?? null,
    title: row.title as string,
    slug: row.slug as string,
    startUrl: (row.start_url as string) ?? null,
    goal: (row.goal as string) ?? null,
    content: (row.content as string) ?? null,
    contentBlocks: parseJsonbField(row.content_blocks),
    customPrompt: (row.custom_prompt as string) ?? null,
    briefing: (row.briefing as DocPageDTO['briefing']) ?? null,
    status: row.status as DocPageDTO['status'],
    isPublic: (row.is_public as boolean) ?? false,
    sortOrder: row.sort_order as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: (row.created_by as string) ?? null,
    lastEditedBy: (row.last_edited_by as string) ?? null,
    lastEditedAt: (row.last_edited_at as string) ?? null,
  }
}

function mapRun(row: Record<string, unknown>): RunDTO {
  return {
    id: row.id as string,
    featureName: row.feature_name as string,
    startUrl: row.start_url as string,
    goal: row.goal as string,
    status: row.status as RunDTO['status'],
    tokenUsage: row.token_usage as number,
    browserbaseSessionId: (row.browserbase_session_id as string) ?? null,
    summaryJson: (row.summary_json as RunDTO['summaryJson']) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

function mapDoc(row: Record<string, unknown>): GeneratedDocDTO {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    markdownContent: (row.markdown_content as string) ?? null,
    jsonContent: (row.json_content as Record<string, unknown>) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}
