import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { GeneratedDoc } from './documentation.types.js'

interface DocRow {
  id: string
  run_id: string
  markdown_content: string | null
  json_content: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

function mapToDoc(row: DocRow): GeneratedDoc {
  return {
    id: row.id,
    runId: row.run_id,
    markdownContent: row.markdown_content,
    jsonContent: row.json_content,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export async function findDocByRunId(runId: string): Promise<GeneratedDoc | null> {
  const { data, error } = await supabase
    .from('generated_docs')
    .select('*')
    .eq('run_id', runId)
    .single()
  if (error && error.code === 'PGRST116') return null
  if (error) throw new DatabaseError(error.message)
  return data ? mapToDoc(data as DocRow) : null
}

export async function upsertDoc(input: {
  runId: string
  markdownContent: string
  jsonContent: Record<string, unknown>
}): Promise<GeneratedDoc> {
  const { data, error } = await supabase
    .from('generated_docs')
    .upsert(
      {
        run_id: input.runId,
        markdown_content: input.markdownContent,
        json_content: input.jsonContent,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'run_id' },
    )
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToDoc(data as DocRow)
}
