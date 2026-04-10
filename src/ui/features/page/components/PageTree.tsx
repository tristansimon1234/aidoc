import { useState, useRef, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { DocPageDTO } from '../../../shared/api/client.js'
import { reorderPages, deletePage } from '../../../shared/api/db.js'
import styles from './PageTree.module.css'

interface PageTreeProps {
  pages: DocPageDTO[]
  projectId: string
  activePageId?: string
  onRefresh: () => Promise<void>
  searchQuery?: string
}

/** Horizontal drag offset (px) past which a drop is treated as "nest inside". */
const NEST_THRESHOLD_PX = 30

function buildTree(pages: DocPageDTO[]): DocPageDTO[] {
  const map = new Map<string, DocPageDTO & { children: DocPageDTO[] }>()
  const roots: DocPageDTO[] = []
  for (const p of pages) map.set(p.id, { ...p, children: [] })
  for (const p of pages) {
    const node = map.get(p.id)!
    if (p.parentId && map.has(p.parentId)) {
      map.get(p.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

function flattenTree(
  pages: DocPageDTO[],
  collapsed: Set<string>,
  depth = 0,
): { page: DocPageDTO; depth: number; hasChildren: boolean }[] {
  const result: { page: DocPageDTO; depth: number; hasChildren: boolean }[] = []
  for (const p of pages) {
    const hasChildren = (p.children?.length ?? 0) > 0
    result.push({ page: p, depth, hasChildren })
    if (hasChildren && !collapsed.has(p.id)) {
      result.push(...flattenTree(p.children!, collapsed, depth + 1))
    }
  }
  return result
}

function matchesSearch(page: DocPageDTO, query: string): boolean {
  if (!query) return true
  return page.title.toLowerCase().includes(query.toLowerCase())
}

/** Check whether `candidateChildId` is a descendant of `parentId`. */
function isDescendantOf(pages: DocPageDTO[], candidateChildId: string, parentId: string): boolean {
  const byId = new Map(pages.map((p) => [p.id, p]))
  let current = byId.get(candidateChildId)
  while (current) {
    if (current.parentId === parentId) return true
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return false
}

export function PageTree({ pages, projectId, activePageId, onRefresh, searchQuery = '' }: PageTreeProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dragId, setDragId] = useState<string | null>(null)
  const [nestTarget, setNestTarget] = useState<string | null>(null)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpenId) return
    const handler = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpenId])

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const tree = buildTree(pages)
  const flatItems = searchQuery
    ? pages.filter((p) => matchesSearch(p, searchQuery)).map((p) => ({ page: p, depth: 0, hasChildren: false }))
    : flattenTree(tree, collapsed)
  const ids = flatItems.map((item) => item.page.id)

  const handleDragStart = (event: { active: { id: string | number } }): void => {
    setDragId(event.active.id as string)
  }

  const handleDragOver = (event: DragOverEvent): void => {
    const { active, over, delta } = event
    if (!over || active.id === over.id) {
      setNestTarget(null)
      return
    }
    // When the pointer is shifted right beyond the threshold, signal nesting.
    // delta.x is the cumulative horizontal movement from drag start —
    // a positive value means the user is deliberately dragging right.
    if (delta.x > NEST_THRESHOLD_PX) {
      setNestTarget(over.id as string)
    } else {
      setNestTarget(null)
    }
  }

  const handleDragEnd = async (event: DragEndEvent): Promise<void> => {
    const currentNestTarget = nestTarget
    setDragId(null)
    setNestTarget(null)

    const { active, over, delta } = event
    if (!over || active.id === over.id) return

    const oldIndex = ids.indexOf(active.id as string)
    const newIndex = ids.indexOf(over.id as string)
    if (oldIndex === -1 || newIndex === -1) return

    const overItem = flatItems[newIndex]
    if (!overItem) return

    const activeItem = flatItems[oldIndex]
    if (!activeItem) return

    // Determine whether to nest as child of the over item.
    //
    // Nesting is triggered when ANY of these conditions is true:
    //   1. The user shifted right > NEST_THRESHOLD_PX during drag (nestTarget set
    //      via onDragOver) — this allows nesting into ANY page, including leaves.
    //   2. The final delta.x at drop time exceeds the threshold (covers the case
    //      where onDragOver state was stale due to fast pointer movement).
    //   3. The over item is an expanded parent (has visible children) — in that case
    //      the intuitive behavior is to insert as the first child.
    const wantsNestFromState = currentNestTarget === overItem.page.id
    const wantsNestFromDelta = delta.x > NEST_THRESHOLD_PX
    const expandedParent = overItem.hasChildren && !collapsed.has(overItem.page.id)
    const dropAsChild = wantsNestFromState || wantsNestFromDelta || expandedParent

    // Prevent nesting a page inside itself or its own descendants
    const wouldCycle = dropAsChild && (
      overItem.page.id === activeItem.page.id ||
      isDescendantOf(pages, overItem.page.id, activeItem.page.id)
    )

    const newParentId = (dropAsChild && !wouldCycle) ? overItem.page.id : overItem.page.parentId

    // If we just nested into a collapsed (or leaf) page, auto-expand it so the
    // user can immediately see the newly nested child.
    if (dropAsChild && !wouldCycle) {
      setCollapsed((prev) => {
        if (!prev.has(overItem.page.id)) return prev
        const next = new Set(prev)
        next.delete(overItem.page.id)
        return next
      })
    }

    const reordered = [...flatItems]
    const [moved] = reordered.splice(oldIndex, 1)
    if (!moved) return
    reordered.splice(newIndex, 0, moved)

    const updates = reordered.map((item, i) => ({
      id: item.page.id,
      parentId: item.page.id === (active.id as string) ? newParentId : item.page.parentId,
      sortOrder: i,
    }))

    try {
      await reorderPages(projectId, updates)
      await onRefresh()
    } catch { /* revert handled by onRefresh */ }
  }

  const handleMove = async (pageId: string, newParentId: string | null): Promise<void> => {
    // Find the highest sort order among the new parent's current children
    const siblings = pages.filter((p) => p.parentId === newParentId)
    const maxSort = siblings.reduce((max, p) => Math.max(max, p.sortOrder), -1)

    await reorderPages(projectId, [{
      id: pageId,
      parentId: newParentId,
      sortOrder: maxSort + 1,
    }])
    await onRefresh()
  }

  const draggedItem = dragId ? flatItems.find((i) => i.page.id === dragId) : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={(e) => void handleDragEnd(e)}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className={styles.tree}>
          {flatItems.map(({ page, depth, hasChildren }) => (
            <SortablePageNode
              key={page.id}
              page={page}
              allPages={pages}
              depth={searchQuery ? 0 : depth}
              hasChildren={hasChildren}
              isCollapsed={collapsed.has(page.id)}
              onToggleCollapse={() => toggleCollapse(page.id)}
              projectId={projectId}
              isActive={page.id === activePageId}
              isDragging={page.id === dragId}
              isNestTarget={nestTarget === page.id}
              menuOpen={menuOpenId === page.id}
              onMenuToggle={() => setMenuOpenId(menuOpenId === page.id ? null : page.id)}
              menuRef={menuOpenId === page.id ? menuRef : undefined}
              onRefresh={onRefresh}
              onMenuClose={() => setMenuOpenId(null)}
              onMove={handleMove}
            />
          ))}
        </div>
      </SortableContext>

      <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }}>
        {draggedItem && (
          <div className={styles.dragOverlay}>
            <span className={`${styles.statusDot} ${styles[draggedItem.page.status]}`} />
            <span className={styles.label}>{draggedItem.page.title}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

function SortablePageNode({
  page,
  allPages,
  depth,
  hasChildren,
  isCollapsed,
  onToggleCollapse,
  projectId,
  isActive,
  isDragging,
  isNestTarget,
  menuOpen,
  onMenuToggle,
  menuRef,
  onRefresh,
  onMenuClose,
  onMove,
}: {
  page: DocPageDTO
  allPages: DocPageDTO[]
  depth: number
  hasChildren: boolean
  isCollapsed: boolean
  onToggleCollapse: () => void
  projectId: string
  isActive: boolean
  isDragging: boolean
  isNestTarget: boolean
  menuOpen: boolean
  onMenuToggle: () => void
  menuRef?: React.RefObject<HTMLDivElement | null>
  onRefresh: () => Promise<void>
  onMenuClose: () => void
  onMove: (pageId: string, newParentId: string | null) => Promise<void>
}): React.ReactElement {
  const navigate = useNavigate()
  const [showMoveList, setShowMoveList] = useState(false)

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: page.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    paddingLeft: `${depth * 20 + 4}px`,
    opacity: isDragging ? 0.3 : 1,
  }

  const handleDelete = async (): Promise<void> => {
    onMenuClose()
    await deletePage(projectId, page.id)
    await onRefresh()
    navigate(`/projects/${projectId}`)
  }

  const handleMoveInside = async (targetId: string): Promise<void> => {
    onMenuClose()
    setShowMoveList(false)
    await onMove(page.id, targetId)
  }

  const handleMoveToRoot = async (): Promise<void> => {
    onMenuClose()
    setShowMoveList(false)
    await onMove(page.id, null)
  }

  // Build list of valid move targets (exclude self and descendants)
  const moveTargets = allPages.filter((p) => {
    if (p.id === page.id) return false
    // Prevent moving inside own descendants
    return !isDescendantOf(allPages, p.id, page.id)
  })

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${styles.nodeRow} ${isActive ? styles.nodeRowActive : ''} ${isNestTarget ? styles.nodeRowNestTarget : ''}`}
    >
      {/* Collapse toggle or spacer */}
      {hasChildren ? (
        <button className={styles.collapseBtn} onClick={onToggleCollapse}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={isCollapsed ? styles.chevronCollapsed : styles.chevronExpanded}
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      ) : (
        <span className={styles.collapseSpacer} />
      )}

      {/* Drag handle */}
      <span className={styles.dragHandle} {...attributes} {...listeners}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="8" cy="6" r="2" /><circle cx="16" cy="6" r="2" />
          <circle cx="8" cy="12" r="2" /><circle cx="16" cy="12" r="2" />
          <circle cx="8" cy="18" r="2" /><circle cx="16" cy="18" r="2" />
        </svg>
      </span>

      {/* Page link */}
      <Link
        to={`/projects/${projectId}/pages/${page.id}`}
        className={`${styles.node} ${isActive ? styles.active : ''}`}
      >
        <span className={`${styles.statusDot} ${styles[page.status]}`} />
        <span className={styles.label}>{page.title}</span>
      </Link>

      {/* Menu button */}
      <button
        className={styles.menuBtn}
        onClick={(e) => { e.stopPropagation(); onMenuToggle(); setShowMoveList(false) }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="6" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="18" r="1.5" />
        </svg>
      </button>

      {/* Context menu */}
      {menuOpen && (
        <div className={styles.menu} ref={menuRef as React.RefObject<HTMLDivElement>}>
          {!showMoveList ? (
            <>
              {/* Move inside */}
              {moveTargets.length > 0 && (
                <button className={styles.menuItem} onClick={() => setShowMoveList(true)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
                  Move inside...
                </button>
              )}

              {/* Move to root */}
              {page.parentId && (
                <button className={styles.menuItem} onClick={() => void handleMoveToRoot()}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6" /></svg>
                  Move to root
                </button>
              )}

              {/* Separator */}
              <div className={styles.menuSep} />

              {/* Delete */}
              <button className={`${styles.menuItem} ${styles.danger}`} onClick={() => void handleDelete()}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
                Delete
              </button>
            </>
          ) : (
            <div className={styles.menuSubList}>
              <button className={styles.menuItem} onClick={() => setShowMoveList(false)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
                Back
              </button>
              <div className={styles.menuSep} />
              {moveTargets.map((target) => (
                <button
                  key={target.id}
                  className={`${styles.menuItem} ${styles.menuSubItem}`}
                  onClick={() => void handleMoveInside(target.id)}
                >
                  <span className={`${styles.statusDot} ${styles[target.status]}`} />
                  <span className={styles.menuSubLabel}>{target.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
