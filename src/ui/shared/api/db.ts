import { supabase } from './supabase.js'
import type { DocPageDTO, RunDTO, GeneratedDocDTO, ProjectDTO } from './client.js'

// Direct Supabase queries — bypass Vercel serverless for reads

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
