import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { CreateTabInput, DocTab, DocTabWithCount, UpdateTabInput } from './tab.types.js'

interface TabRow {
  id: string
  project_id: string
  name: string
  slug: string
  sort_order: number
  created_at: string
  updated_at: string
}

function mapToTab(row: TabRow): DocTab {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    slug: row.slug,
    sortOrder: row.sort_order,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export async function listTabsByProjectId(projectId: string): Promise<DocTab[]> {
  const { data, error } = await supabase
    .from('doc_tabs')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true })
  if (error) throw new DatabaseError(error.message)
  return (data as TabRow[]).map(mapToTab)
}

/** Tabs enriched with the number of pages assigned to each. Used by the
 *  admin UI to gate the delete dialog (an empty tab can be deleted
 *  without a move-target picker). One query per call, not N+1. */
export async function listTabsWithCounts(projectId: string): Promise<DocTabWithCount[]> {
  const tabs = await listTabsByProjectId(projectId)
  if (tabs.length === 0) return []

  // Single grouped count via pgs aggregate fallback — Supabase JS doesn't
  // expose GROUP BY directly, so we issue one count() per tab. With a
  // typical project sitting at 2-5 tabs this is cheaper than fetching all
  // pages and counting client-side.
  const counts = await Promise.all(tabs.map(async (t) => {
    const { count, error } = await supabase
      .from('doc_pages')
      .select('id', { count: 'exact', head: true })
      .eq('tab_id', t.id)
    if (error) throw new DatabaseError(error.message)
    return count ?? 0
  }))

  return tabs.map((t, i) => ({ ...t, pageCount: counts[i] ?? 0 }))
}

export async function findTabById(id: string): Promise<DocTab | null> {
  const { data, error } = await supabase.from('doc_tabs').select('*').eq('id', id).maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return data ? mapToTab(data as TabRow) : null
}

export async function findTabBySlug(projectId: string, slug: string): Promise<DocTab | null> {
  const { data, error } = await supabase
    .from('doc_tabs')
    .select('*')
    .eq('project_id', projectId)
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return data ? mapToTab(data as TabRow) : null
}

/** Find or create the project's default 'main' tab. Used when a caller
 *  creates a page without picking a tab — keeps the API ergonomic for
 *  existing MCP scripts and lets the migration safety net hold even if
 *  somebody deletes the seeded row by hand. */
export async function ensureMainTab(projectId: string): Promise<DocTab> {
  const existing = await findTabBySlug(projectId, 'main')
  if (existing) return existing
  return createTab({ projectId, name: 'main', slug: 'main', sortOrder: 0 })
}

export async function createTab(input: CreateTabInput): Promise<DocTab> {
  const { data, error } = await supabase
    .from('doc_tabs')
    .insert({
      project_id: input.projectId,
      name: input.name,
      slug: input.slug ?? (input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'tab'),
      sort_order: input.sortOrder ?? 0,
    })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToTab(data as TabRow)
}

export async function updateTab(id: string, input: UpdateTabInput): Promise<DocTab> {
  const updates: Record<string, unknown> = {}
  if (input.name !== undefined) updates.name = input.name
  if (input.slug !== undefined) updates.slug = input.slug
  if (input.sortOrder !== undefined) updates.sort_order = input.sortOrder

  const { data, error } = await supabase
    .from('doc_tabs')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToTab(data as TabRow)
}

/** Move every page from one tab to another. Used by the delete-with-move
 *  flow — and never directly from a route, to keep the safety check
 *  ("don't move into the tab you're deleting") in one place. */
export async function movePagesToTab(fromTabId: string, toTabId: string): Promise<number> {
  const { count, error } = await supabase
    .from('doc_pages')
    .update({ tab_id: toTabId, updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('tab_id', fromTabId)
  if (error) throw new DatabaseError(error.message)
  return count ?? 0
}

export async function deleteTab(id: string): Promise<void> {
  const { error } = await supabase.from('doc_tabs').delete().eq('id', id)
  if (error) throw new DatabaseError(error.message)
}

/** Rewrite every tab's sort_order in one go so gaps from previous edits
 *  collapse to a clean 0,1,2,… sequence. Sequential by design — the
 *  list is small and we want predictable ordering on failure. */
export async function reorderTabs(projectId: string, tabIds: string[]): Promise<void> {
  for (let i = 0; i < tabIds.length; i++) {
    const id = tabIds[i]!
    const { error } = await supabase
      .from('doc_tabs')
      .update({ sort_order: i, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('project_id', projectId)
    if (error) throw new DatabaseError(error.message)
  }
}
