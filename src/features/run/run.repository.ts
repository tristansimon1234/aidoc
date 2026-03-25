import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { Run, RunStatus, RunStep } from './run.types.js'

interface RunRow {
  id: string
  feature_name: string
  start_url: string
  goal: string
  status: string
  token_usage: number
  browserbase_session_id: string | null
  doc_page_id: string | null
  created_at: string
  updated_at: string
}

interface RunStepRow {
  id: string
  run_id: string
  step_index: number
  url: string | null
  title: string | null
  action: string | null
  observation: string | null
  screenshot_path: string | null
  status: string
  created_at: string
}

function mapToRun(row: RunRow): Run {
  return {
    id: row.id,
    featureName: row.feature_name,
    startUrl: row.start_url,
    goal: row.goal,
    status: row.status as RunStatus,
    tokenUsage: row.token_usage,
    browserbaseSessionId: row.browserbase_session_id,
    docPageId: row.doc_page_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapToRunStep(row: RunStepRow): RunStep {
  return {
    id: row.id,
    runId: row.run_id,
    stepIndex: row.step_index,
    url: row.url,
    title: row.title,
    action: row.action,
    observation: row.observation,
    screenshotPath: row.screenshot_path,
    status: row.status as RunStep['status'],
    createdAt: new Date(row.created_at),
  }
}

export async function createRun(input: {
  featureName: string
  startUrl: string
  goal: string
  docPageId?: string
}): Promise<Run> {
  const { data, error } = await supabase
    .from('runs')
    .insert({
      feature_name: input.featureName,
      start_url: input.startUrl,
      goal: input.goal,
      doc_page_id: input.docPageId ?? null,
    })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToRun(data as RunRow)
}

export async function findLatestRunByPageId(pageId: string): Promise<Run | null> {
  const { data, error } = await supabase
    .from('runs')
    .select('*')
    .eq('doc_page_id', pageId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  if (error && error.code === 'PGRST116') return null
  if (error) throw new DatabaseError(error.message)
  return data ? mapToRun(data as RunRow) : null
}

export async function findRunById(id: string): Promise<Run | null> {
  const { data, error } = await supabase.from('runs').select('*').eq('id', id).single()
  if (error && error.code === 'PGRST116') return null
  if (error) throw new DatabaseError(error.message)
  return data ? mapToRun(data as RunRow) : null
}

export async function listRuns(): Promise<Run[]> {
  const { data, error } = await supabase
    .from('runs')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new DatabaseError(error.message)
  return (data as RunRow[]).map(mapToRun)
}

export async function updateRunStatus(id: string, status: RunStatus): Promise<Run> {
  const { data, error } = await supabase
    .from('runs')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToRun(data as RunRow)
}

export async function setBrowserbaseSessionId(id: string, sessionId: string): Promise<void> {
  const { error } = await supabase
    .from('runs')
    .update({ browserbase_session_id: sessionId, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new DatabaseError(error.message)
}

export async function incrementTokenUsage(id: string, tokens: number): Promise<void> {
  const run = await findRunById(id)
  if (!run) throw new DatabaseError(`Run ${id} not found`)
  const { error } = await supabase
    .from('runs')
    .update({
      token_usage: run.tokenUsage + tokens,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) throw new DatabaseError(error.message)
}

export async function countStepsByRunId(runId: string): Promise<number> {
  const { count, error } = await supabase
    .from('run_steps')
    .select('*', { count: 'exact', head: true })
    .eq('run_id', runId)
  if (error) throw new DatabaseError(error.message)
  return count ?? 0
}

export async function findStepsByRunId(runId: string): Promise<RunStep[]> {
  const { data, error } = await supabase
    .from('run_steps')
    .select('*')
    .eq('run_id', runId)
    .order('step_index', { ascending: true })
  if (error) throw new DatabaseError(error.message)
  return (data as RunStepRow[]).map(mapToRunStep)
}

export async function createRunStep(input: {
  runId: string
  stepIndex: number
  url?: string
  title?: string
  action?: string
  observation?: string
  screenshotPath?: string
  status?: RunStep['status']
}): Promise<RunStep> {
  const { data, error } = await supabase
    .from('run_steps')
    .insert({
      run_id: input.runId,
      step_index: input.stepIndex,
      url: input.url ?? null,
      title: input.title ?? null,
      action: input.action ?? null,
      observation: input.observation ?? null,
      screenshot_path: input.screenshotPath ?? null,
      status: input.status ?? 'completed',
    })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToRunStep(data as RunStepRow)
}
