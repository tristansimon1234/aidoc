import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { DocChunk } from './chat.types.js'

export async function deleteEmbeddingsByPageId(pageId: string): Promise<void> {
  const { error } = await supabase
    .from('doc_embeddings')
    .delete()
    .eq('page_id', pageId)
  if (error) throw new DatabaseError(error.message)
}

export async function insertEmbeddings(
  rows: {
    projectId: string
    pageId: string
    chunkIndex: number
    chunkText: string
    embedding: number[]
    pageTitle: string
    pageSlug: string
  }[],
): Promise<void> {
  if (rows.length === 0) return

  const { error } = await supabase.from('doc_embeddings').insert(
    rows.map((r) => ({
      project_id: r.projectId,
      page_id: r.pageId,
      chunk_index: r.chunkIndex,
      chunk_text: r.chunkText,
      embedding: JSON.stringify(r.embedding),
      page_title: r.pageTitle,
      page_slug: r.pageSlug,
    })),
  )
  if (error) throw new DatabaseError(error.message)
}

export async function searchChunks(
  projectId: string,
  queryEmbedding: number[],
  matchCount = 8,
  matchThreshold = 0.3,
): Promise<DocChunk[]> {
  const { data, error } = await supabase.rpc('match_doc_chunks', {
    p_project_id: projectId,
    p_embedding: JSON.stringify(queryEmbedding),
    p_match_count: matchCount,
    p_match_threshold: matchThreshold,
  })
  if (error) throw new DatabaseError(error.message)

  return ((data ?? []) as {
    id: string
    page_id: string
    page_title: string
    page_slug: string
    chunk_index: number
    chunk_text: string
    similarity: number
  }[]).map((row) => ({
    id: row.id,
    pageId: row.page_id,
    pageTitle: row.page_title,
    pageSlug: row.page_slug,
    chunkIndex: row.chunk_index,
    chunkText: row.chunk_text,
    similarity: row.similarity,
  }))
}

export async function hasEmbeddings(projectId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('doc_embeddings')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
  if (error) throw new DatabaseError(error.message)
  return (count ?? 0) > 0
}
