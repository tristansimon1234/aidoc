import { supabase } from '../../shared/db/supabase.client.js'

export type JobType =
  | 'exploration'        // /api/runs/:id/explore (Try Doc + open exploration)
  | 'doc-gen'            // /api/runs/:id/generate-doc + analyze-video?generateDoc=1
  | 'voiceover'          // /api/runs/:id/generate-voiceover
  | 'try-doc-analysis'   // /api/runs/:id/analyze-try
  | 'try-doc'            // legacy frontend alias — kept so JobTracker doesn't 404 existing rows
  | 'index'              // /api/projects/:pid/chat/index
export type JobStatus = 'running' | 'completed' | 'failed'

export interface Job {
  id: string
  runId: string | null
  pageId: string | null
  projectId: string
  type: JobType
  status: JobStatus
  triggeredByUserId: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    runId: (row.run_id as string | null) ?? null,
    pageId: (row.page_id as string | null) ?? null,
    projectId: row.project_id as string,
    type: row.type as JobType,
    status: row.status as JobStatus,
    triggeredByUserId: (row.triggered_by_user_id as string | null) ?? null,
    error: (row.error as string) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }
}

export async function createJob(input: {
  runId: string | null
  pageId: string | null
  projectId: string
  type: JobType
  triggeredByUserId?: string | null
}): Promise<Job> {
  const { data, error } = await supabase
    .from('jobs')
    .insert({
      run_id: input.runId,
      page_id: input.pageId,
      project_id: input.projectId,
      type: input.type,
      status: 'running',
      triggered_by_user_id: input.triggeredByUserId ?? null,
    })
    .select()
    .single()

  if (error || !data) throw new Error(`Failed to create job: ${error?.message}`)
  return rowToJob(data)
}

export async function updateJobStatus(id: string, status: JobStatus, error?: string): Promise<void> {
  const { error: dbErr } = await supabase
    .from('jobs')
    .update({ status, error: error ?? null, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (dbErr) throw new Error(`Failed to update job: ${dbErr.message}`)
}

export async function findRunningJobsByProject(projectId: string): Promise<Job[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'running')
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Failed to fetch jobs: ${error.message}`)
  return (data ?? []).map(rowToJob)
}

export async function findRecentJobsByProject(projectId: string): Promise<Job[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('project_id', projectId)
    .gte('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString()) // last hour
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Failed to fetch jobs: ${error.message}`)
  return (data ?? []).map(rowToJob)
}

/**
 * Look up the single running job that would collide with a new createJob()
 * call for `(pageId, type)` — used to build the "Alice is already generating"
 * 409 payload after a PK conflict. Returns null if none is running (e.g. the
 * job finished between the INSERT failure and this lookup).
 */
export async function findRunningJobForPage(pageId: string, type: JobType): Promise<Job | null> {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('page_id', pageId)
    .eq('type', type)
    .eq('status', 'running')
    .maybeSingle()
  if (error) throw new Error(`Failed to fetch running job: ${error.message}`)
  return data ? rowToJob(data) : null
}

/** Same as findRunningJobForPage but for project-scoped jobs (page_id IS NULL). */
export async function findRunningJobForProject(projectId: string, type: JobType): Promise<Job | null> {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('project_id', projectId)
    .eq('type', type)
    .eq('status', 'running')
    .is('page_id', null)
    .maybeSingle()
  if (error) throw new Error(`Failed to fetch running job: ${error.message}`)
  return data ? rowToJob(data) : null
}
