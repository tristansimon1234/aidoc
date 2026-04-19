import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'

/**
 * Activity feed — derived on-the-fly from existing tables. No dedicated
 * `activities` table yet; we read the three sources that already track
 * who/when and merge + sort in JS. Cheap for ~hundreds of rows; revisit if
 * any project pushes past a few thousand pages.
 */

export interface RawPageEdit {
  pageId: string
  title: string
  projectId: string
  lastEditedBy: string | null
  lastEditedAt: string
}

export interface RawDocGeneration {
  pageId: string
  pageTitle: string
  projectId: string
  triggeredByUserId: string | null
  completedAt: string
}

export interface RawMemberJoin {
  userId: string
  role: string
  joinedAt: string
}

export async function listRecentPageEdits(projectId: string, limit: number): Promise<RawPageEdit[]> {
  const { data, error } = await supabase
    .from('doc_pages')
    .select('id, title, project_id, last_edited_by, last_edited_at')
    .eq('project_id', projectId)
    .not('last_edited_at', 'is', null)
    .order('last_edited_at', { ascending: false })
    .limit(limit)
  if (error) throw new DatabaseError(error.message)
  return (data ?? []).map((r) => {
    const row = r as { id: string; title: string; project_id: string; last_edited_by: string | null; last_edited_at: string }
    return {
      pageId: row.id,
      title: row.title,
      projectId: row.project_id,
      lastEditedBy: row.last_edited_by,
      lastEditedAt: row.last_edited_at,
    }
  })
}

export async function listRecentDocGenerations(projectId: string, limit: number): Promise<RawDocGeneration[]> {
  // runs.status='completed' AND docPageId IN (pages of project). Runs don't
  // know their team_id directly — join via doc_pages.
  const { data, error } = await supabase
    .from('runs')
    .select('id, doc_page_id, updated_at, status, doc_pages!inner(id, title, project_id)')
    .eq('status', 'completed')
    .eq('doc_pages.project_id', projectId)
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (error) throw new DatabaseError(error.message)
  return (data ?? []).map((r) => {
    const row = r as unknown as {
      id: string
      doc_page_id: string
      updated_at: string
      doc_pages: { id: string; title: string; project_id: string } | { id: string; title: string; project_id: string }[]
    }
    const page = Array.isArray(row.doc_pages) ? row.doc_pages[0]! : row.doc_pages
    return {
      pageId: page.id,
      pageTitle: page.title,
      projectId: page.project_id,
      // Runs don't track the triggering user yet — leave null for now. The
      // email ping flow passes it explicitly, but the DB doesn't persist it.
      triggeredByUserId: null,
      completedAt: row.updated_at,
    }
  })
}

export async function listRecentMemberJoins(teamId: string, limit: number): Promise<RawMemberJoin[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('user_id, role, joined_at')
    .eq('team_id', teamId)
    .order('joined_at', { ascending: false })
    .limit(limit)
  if (error) throw new DatabaseError(error.message)
  return (data ?? []).map((r) => {
    const row = r as { user_id: string; role: string; joined_at: string }
    return { userId: row.user_id, role: row.role, joinedAt: row.joined_at }
  })
}
