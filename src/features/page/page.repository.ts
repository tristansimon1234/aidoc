import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { DocPage, CreatePageInput, UpdatePageInput, DocPageTreeNode, ReorderItem, PageBriefing } from './page.types.js'

interface PageRow {
  id: string
  project_id: string
  parent_id: string | null
  title: string
  slug: string
  start_url: string | null
  goal: string | null
  content: string | null
  content_blocks: unknown
  previous_content: string | null
  previous_content_blocks: unknown
  previous_content_saved_at: string | null
  custom_prompt: string | null
  briefing: PageBriefing | null
  status: string
  is_public: boolean
  sort_order: number
  created_at: string
  updated_at: string
  last_edited_by: string | null
  last_edited_at: string | null
  created_by: string | null
}

function mapToPage(row: PageRow): DocPage {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    title: row.title,
    slug: row.slug,
    startUrl: row.start_url,
    goal: row.goal,
    content: row.content,
    contentBlocks: row.content_blocks ?? null,
    previousContent: row.previous_content ?? null,
    previousContentBlocks: row.previous_content_blocks ?? null,
    previousContentSavedAt: row.previous_content_saved_at ? new Date(row.previous_content_saved_at) : null,
    customPrompt: row.custom_prompt,
    briefing: row.briefing ?? null,
    status: row.status as DocPage['status'],
    isPublic: row.is_public,
    sortOrder: row.sort_order,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    createdBy: row.created_by,
    lastEditedBy: row.last_edited_by,
    lastEditedAt: row.last_edited_at ? new Date(row.last_edited_at) : null,
  }
}

export async function createPage(input: CreatePageInput): Promise<DocPage> {
  const { data, error } = await supabase
    .from('doc_pages')
    .insert({
      project_id: input.projectId,
      parent_id: input.parentId ?? null,
      title: input.title,
      slug: input.slug,
      start_url: input.startUrl ?? null,
      goal: input.goal ?? null,
      sort_order: input.sortOrder ?? 0,
    })
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToPage(data as PageRow)
}

export async function findPageById(id: string): Promise<DocPage | null> {
  const { data, error } = await supabase.from('doc_pages').select('*').eq('id', id).single()
  if (error && error.code === 'PGRST116') return null
  if (error) throw new DatabaseError(error.message)
  return data ? mapToPage(data as PageRow) : null
}

export async function findPagesByProjectId(projectId: string): Promise<DocPage[]> {
  const { data, error } = await supabase
    .from('doc_pages')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true })
  if (error) throw new DatabaseError(error.message)
  return (data as PageRow[]).map(mapToPage)
}

export async function findPublicPagesByProjectId(projectId: string): Promise<DocPage[]> {
  // Try is_public first; fall back to status='published' if column missing
  const { data, error } = await supabase
    .from('doc_pages')
    .select('*')
    .eq('project_id', projectId)
    .eq('is_public', true)
    .order('sort_order', { ascending: true })

  if (error && error.message.includes('is_public')) {
    // Column doesn't exist yet — fall back
    const fallback = await supabase
      .from('doc_pages')
      .select('*')
      .eq('project_id', projectId)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
    if (fallback.error) throw new DatabaseError(fallback.error.message)
    return (fallback.data as PageRow[]).map(mapToPage)
  }

  if (error) throw new DatabaseError(error.message)
  return (data as PageRow[]).map(mapToPage)
}

/**
 * Metadata-only row for the public-docs navigation tree. Deliberately
 * skips `content`, `content_blocks`, `briefing` etc. so a project with
 * hundreds of pages ships a small JSON payload to the browser — the
 * actual page content is fetched lazily per slug on selection.
 */
export interface PublicPageMeta {
  id: string
  title: string
  slug: string
  parentId: string | null
  sortOrder: number
  hasVideo: boolean
}

function isShowVideo(briefing: unknown): boolean {
  if (!briefing || typeof briefing !== 'object') return false
  return (briefing as Record<string, unknown>).showVideoOnPublic === true
}

export async function findPublicPagesMetaByProjectId(projectId: string): Promise<PublicPageMeta[]> {
  const columns = 'id, title, slug, parent_id, sort_order, briefing'
  const { data, error } = await supabase
    .from('doc_pages')
    .select(columns)
    .eq('project_id', projectId)
    .eq('is_public', true)
    .order('sort_order', { ascending: true })

  if (error && error.message.includes('is_public')) {
    const fallback = await supabase
      .from('doc_pages')
      .select(columns)
      .eq('project_id', projectId)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
    if (fallback.error) throw new DatabaseError(fallback.error.message)
    return (fallback.data as Array<{ id: string; title: string; slug: string; parent_id: string | null; sort_order: number; briefing: unknown }>)
      .map((r) => ({
        id: r.id,
        title: r.title,
        slug: r.slug,
        parentId: r.parent_id,
        sortOrder: r.sort_order,
        hasVideo: isShowVideo(r.briefing),
      }))
  }

  if (error) throw new DatabaseError(error.message)
  return (data as Array<{ id: string; title: string; slug: string; parent_id: string | null; sort_order: number; briefing: unknown }>)
    .map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      parentId: r.parent_id,
      sortOrder: r.sort_order,
      hasVideo: isShowVideo(r.briefing),
    }))
}

/** Look up a single public page by slug within a project — for lazy content loads. */
export async function findPublicPageBySlug(projectId: string, slug: string): Promise<DocPage | null> {
  const { data, error } = await supabase
    .from('doc_pages')
    .select('*')
    .eq('project_id', projectId)
    .eq('slug', slug)
    .eq('is_public', true)
    .maybeSingle()

  if (error && error.message.includes('is_public')) {
    const fallback = await supabase
      .from('doc_pages')
      .select('*')
      .eq('project_id', projectId)
      .eq('slug', slug)
      .eq('status', 'published')
      .maybeSingle()
    if (fallback.error) throw new DatabaseError(fallback.error.message)
    return fallback.data ? mapToPage(fallback.data as PageRow) : null
  }

  if (error) throw new DatabaseError(error.message)
  return data ? mapToPage(data as PageRow) : null
}

export async function updatePage(id: string, input: UpdatePageInput, editorUserId?: string | null): Promise<DocPage> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.title !== undefined) updates.title = input.title
  if (input.slug !== undefined) updates.slug = input.slug
  if (input.startUrl !== undefined) updates.start_url = input.startUrl
  if (input.goal !== undefined) updates.goal = input.goal
  if (input.parentId !== undefined) updates.parent_id = input.parentId
  if (input.sortOrder !== undefined) updates.sort_order = input.sortOrder
  if (input.status !== undefined) updates.status = input.status
  if (input.content !== undefined) updates.content = input.content
  if (input.contentBlocks !== undefined) updates.content_blocks = input.contentBlocks
  if (input.customPrompt !== undefined) updates.custom_prompt = input.customPrompt
  if (input.briefing !== undefined) updates.briefing = input.briefing
  if (input.isPublic !== undefined) updates.is_public = input.isPublic

  // Only stamp last_edited_* when the caller actually provides an editor id
  // AND the update touches user-facing content — pure metadata updates
  // (reorder, status toggle) shouldn't overwrite "edited by Alice, 2h ago".
  const touchesContent =
    input.content !== undefined ||
    input.contentBlocks !== undefined ||
    input.title !== undefined ||
    input.briefing !== undefined
  if (editorUserId && touchesContent) {
    updates.last_edited_by = editorUserId
    updates.last_edited_at = new Date().toISOString()
  }

  const { data, error } = await supabase
    .from('doc_pages')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToPage(data as PageRow)
}

export async function deletePage(id: string): Promise<void> {
  const { error } = await supabase.from('doc_pages').delete().eq('id', id)
  if (error) throw new DatabaseError(error.message)
}

export async function reorderPages(items: ReorderItem[]): Promise<void> {
  for (const item of items) {
    const { error } = await supabase
      .from('doc_pages')
      .update({
        parent_id: item.parentId,
        sort_order: item.sortOrder,
        updated_at: new Date().toISOString(),
      })
      .eq('id', item.id)
    if (error) throw new DatabaseError(error.message)
  }
}

export async function updatePageContent(id: string, content: string): Promise<void> {
  // Snapshot the current content into the previous_* columns before we
  // overwrite, so an accidental regeneration is recoverable. Only one
  // snapshot is kept (latest wins) — good enough for the "I didn't mean
  // to click that" undo without the weight of full versioning.
  const { data: current, error: fetchErr } = await supabase
    .from('doc_pages')
    .select('content, content_blocks')
    .eq('id', id)
    .single()
  if (fetchErr) throw new DatabaseError(fetchErr.message)

  const updates: Record<string, unknown> = {
    // Wipe content_blocks on fresh generation: the editor parses the new
    // markdown on next open and persists JSON from that. Without the wipe,
    // stale blocks from a previous generation would override the new content.
    content,
    content_blocks: null,
    updated_at: new Date().toISOString(),
  }

  const currentContent = (current as { content: string | null; content_blocks: unknown } | null)?.content
  if (currentContent?.trim()) {
    updates.previous_content = currentContent
    updates.previous_content_blocks = (current as { content_blocks: unknown } | null)?.content_blocks ?? null
    updates.previous_content_saved_at = new Date().toISOString()
  }

  const { error } = await supabase.from('doc_pages').update(updates).eq('id', id)
  if (error) throw new DatabaseError(error.message)
}

/** Restore the most recent snapshot into `content` / `content_blocks` and
 *  clear the snapshot. Throws when there's nothing to restore. */
export async function restorePreviousContent(id: string): Promise<DocPage> {
  const { data: current, error: fetchErr } = await supabase
    .from('doc_pages')
    .select('previous_content, previous_content_blocks, previous_content_saved_at')
    .eq('id', id)
    .single()
  if (fetchErr) throw new DatabaseError(fetchErr.message)
  const row = current as {
    previous_content: string | null
    previous_content_blocks: unknown
    previous_content_saved_at: string | null
  } | null
  if (!row?.previous_content) {
    throw new DatabaseError('No previous version to restore')
  }

  const { data, error } = await supabase
    .from('doc_pages')
    .update({
      content: row.previous_content,
      content_blocks: row.previous_content_blocks ?? null,
      previous_content: null,
      previous_content_blocks: null,
      previous_content_saved_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new DatabaseError(error.message)
  return mapToPage(data as PageRow)
}

export function buildTree(pages: DocPage[]): DocPageTreeNode[] {
  const map = new Map<string, DocPageTreeNode>()
  const roots: DocPageTreeNode[] = []

  for (const page of pages) {
    map.set(page.id, { ...page, children: [] })
  }

  for (const page of pages) {
    const node = map.get(page.id)!
    if (page.parentId && map.has(page.parentId)) {
      map.get(page.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}
