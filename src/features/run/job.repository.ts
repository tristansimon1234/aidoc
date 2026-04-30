import { supabase } from '../../shared/db/supabase.client.js'

export type JobType = 'doc-gen' | 'voiceover' | 'try-doc' | 'marketing-video'
export type JobStatus = 'running' | 'completed' | 'failed'

export interface Job {
  id: string
  runId: string
  pageId: string
  projectId: string
  type: JobType
  status: JobStatus
  error: string | null
  createdAt: Date
  updatedAt: Date
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    pageId: row.page_id as string,
    projectId: row.project_id as string,
    type: row.type as JobType,
    status: row.status as JobStatus,
    error: (row.error as string) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }
}

export async function createJob(input: {
  runId: string
  pageId: string
  projectId: string
  type: JobType
}): Promise<Job> {
  const { data, error } = await supabase
    .from('jobs')
    .insert({
      run_id: input.runId,
      page_id: input.pageId,
      project_id: input.projectId,
      type: input.type,
      status: 'running',
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
