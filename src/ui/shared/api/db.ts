import { supabase } from './supabase.js'
import type { DocPageDTO, RunDTO, GeneratedDocDTO, ProjectDTO, ProjectContextDTO, TryDocReportDTO } from './client.js'

// Direct Supabase queries — bypass Vercel serverless

export async function fetchPageFull(pageId: string): Promise<{
  page: DocPageDTO
  latestRun: RunDTO | null
  doc: GeneratedDocDTO | null
}> {
  const [pageResult, runResult, docResult] = await Promise.all([
    supabase.from('doc_pages').select('*').eq('id', pageId).single(),
    supabase.from('runs').select('*').eq('doc_page_id', pageId).order('created_at', { ascending: false }).limit(1).single(),
    supabase.from('generated_docs').select('*').eq('doc_page_id', pageId).order('updated_at', { ascending: false }).limit(1).single(),
  ])

  if (pageResult.error) throw new Error(pageResult.error.message)

  const page = mapPage(pageResult.data)

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
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map(mapProject)
}

// --- Writes ---

export async function createProject(body: {
  name: string
  baseUrl: string
  context?: ProjectContextDTO
  credentials?: { label: string; username: string; password: string }[]
}): Promise<ProjectDTO> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase
    .from('projects')
    .insert({
      user_id: user.id,
      name: body.name,
      base_url: body.baseUrl,
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
  if (body.discoveredContext !== undefined) updates.discovered_context = body.discoveredContext
  if (body.design !== undefined) updates.design = body.design

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
  if (body.customPrompt !== undefined) updates.custom_prompt = body.customPrompt
  if (body.briefing !== undefined) updates.briefing = body.briefing

  const { data, error } = await supabase.from('doc_pages').update(updates).eq('id', pageId).select('*').single()
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

// --- snake_case → camelCase mappers ---

function mapProject(row: Record<string, unknown>): ProjectDTO {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    baseUrl: row.base_url as string,
    description: (row.description as string) ?? null,
    context: (row.context as ProjectDTO['context']) ?? null,
    discoveredContext: (row.discovered_context as ProjectDTO['discoveredContext']) ?? null,
    design: (row.design as ProjectDTO['design']) ?? null,
    widgetApiKey: (row.widget_api_key as string) ?? null,
    widgetEnabled: (row.widget_enabled as boolean) ?? false,
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
    customPrompt: (row.custom_prompt as string) ?? null,
    briefing: (row.briefing as DocPageDTO['briefing']) ?? null,
    status: row.status as DocPageDTO['status'],
    isPublic: (row.is_public as boolean) ?? false,
    sortOrder: row.sort_order as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
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
