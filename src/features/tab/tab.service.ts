import { AppError, NotFoundError, ValidationError } from '../../shared/middleware/error.middleware.js'
import * as tabRepo from './tab.repository.js'
import type { DocTab, DocTabWithCount } from './tab.types.js'

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'tab'
}

/** Resolve a unique slug for a new tab. If the requested (or derived)
 *  slug collides with an existing tab in the project, suffix `-2`, `-3`
 *  etc. so the user doesn't see a 500 on a duplicate name. */
async function resolveUniqueSlug(projectId: string, base: string): Promise<string> {
  let candidate = base
  let suffix = 2
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await tabRepo.findTabBySlug(projectId, candidate)
    if (!existing) return candidate
    candidate = `${base}-${suffix}`
    suffix++
    // Safety bound — a project with 50+ tabs of the same name is a bug.
    if (suffix > 50) throw new ValidationError('Could not derive a unique slug for this tab')
  }
}

export async function listTabs(projectId: string): Promise<DocTabWithCount[]> {
  const tabs = await tabRepo.listTabsWithCounts(projectId)
  // Migration seeds a 'main' tab for every existing project, but a freshly
  // created project doesn't get one until something hits the API — make
  // sure callers always see at least one tab so the UI never renders an
  // empty bar.
  if (tabs.length === 0) {
    const main = await tabRepo.ensureMainTab(projectId)
    return [{ ...main, pageCount: 0 }]
  }
  return tabs
}

export async function createTab(projectId: string, input: { name: string; slug?: string; sortOrder?: number }): Promise<DocTab> {
  const base = input.slug ? slugify(input.slug) : slugify(input.name)
  const slug = await resolveUniqueSlug(projectId, base)

  // Append to the end of the list by default — least surprising.
  if (input.sortOrder === undefined) {
    const tabs = await tabRepo.listTabsByProjectId(projectId)
    input.sortOrder = tabs.length
  }

  return tabRepo.createTab({ projectId, name: input.name, slug, sortOrder: input.sortOrder })
}

export async function updateTab(projectId: string, tabId: string, input: { name?: string; slug?: string; sortOrder?: number }): Promise<DocTab> {
  const existing = await tabRepo.findTabById(tabId)
  if (!existing || existing.projectId !== projectId) throw new NotFoundError('Tab')

  const updates: { name?: string; slug?: string; sortOrder?: number } = {}
  if (input.name !== undefined) updates.name = input.name
  if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder
  if (input.slug !== undefined) {
    const normalized = slugify(input.slug)
    if (normalized !== existing.slug) {
      // Don't auto-suffix on rename — if the user chose a colliding slug,
      // surface it as an error instead of silently mutating their input.
      const collision = await tabRepo.findTabBySlug(projectId, normalized)
      if (collision && collision.id !== tabId) throw new ValidationError('A tab with this slug already exists')
      updates.slug = normalized
    }
  }

  return tabRepo.updateTab(tabId, updates)
}

export interface DeleteTabOptions {
  moveToTabId?: string
  moveToTabSlug?: string
}

/** Delete a tab. If it still has pages, the caller must specify a target
 *  tab via `moveToTabId` or `moveToTabSlug` — we move every page over,
 *  then drop the now-empty tab. Empty tabs can be deleted directly. */
export async function deleteTab(projectId: string, tabId: string, opts: DeleteTabOptions = {}): Promise<void> {
  const existing = await tabRepo.findTabById(tabId)
  if (!existing || existing.projectId !== projectId) throw new NotFoundError('Tab')

  const allTabs = await tabRepo.listTabsByProjectId(projectId)
  if (allTabs.length <= 1) {
    throw new AppError('A project must keep at least one tab', 'TAB_LAST_REMAINING', 400)
  }

  const withCount = (await tabRepo.listTabsWithCounts(projectId)).find((t) => t.id === tabId)
  const pageCount = withCount?.pageCount ?? 0

  if (pageCount > 0) {
    let target: DocTab | null = null
    if (opts.moveToTabId) {
      target = await tabRepo.findTabById(opts.moveToTabId)
    } else if (opts.moveToTabSlug) {
      target = await tabRepo.findTabBySlug(projectId, opts.moveToTabSlug)
    }
    if (!target || target.projectId !== projectId) {
      throw new AppError(`This tab contains ${pageCount} pages. Provide moveToTabId (or moveToTabSlug) to relocate them before deletion.`, 'TAB_NOT_EMPTY', 400, { pageCount })
    }
    if (target.id === tabId) {
      throw new ValidationError('Cannot move pages into the tab being deleted')
    }
    await tabRepo.movePagesToTab(tabId, target.id)
  }

  await tabRepo.deleteTab(tabId)
}

export async function reorderTabs(projectId: string, tabIds: string[]): Promise<void> {
  // Verify every id actually belongs to this project before reshuffling —
  // otherwise a caller could pass another project's tab ids and silently
  // reorder them via the RLS escape hatch on the service role key.
  const tabs = await tabRepo.listTabsByProjectId(projectId)
  const idSet = new Set(tabs.map((t) => t.id))
  for (const id of tabIds) {
    if (!idSet.has(id)) throw new ValidationError(`Tab ${id} does not belong to this project`)
  }
  await tabRepo.reorderTabs(projectId, tabIds)
}

/** Resolve a tab by id or slug. Helper for routes/MCP tools that accept
 *  either. Returns null when nothing matches. */
export async function resolveTab(projectId: string, ref: { tabId?: string; tabSlug?: string }): Promise<DocTab | null> {
  if (ref.tabId) {
    const t = await tabRepo.findTabById(ref.tabId)
    if (!t || t.projectId !== projectId) return null
    return t
  }
  if (ref.tabSlug) return tabRepo.findTabBySlug(projectId, ref.tabSlug)
  return null
}
