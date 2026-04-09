import { useState, useRef, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
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

export function PageTree({ pages, projectId, activePageId, onRefresh, searchQuery = '' }: PageTreeProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dragId, setDragId] = useState<string | null>(null)
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

  const handleDragEnd = async (event: DragEndEvent): Promise<void> => {
    setDragId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = ids.indexOf(active.id as string)
    const newIndex = ids.indexOf(over.id as string)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = [...flatItems]
    const [moved] = reordered.splice(oldIndex, 1)
    if (!moved) return
    reordered.splice(newIndex, 0, moved)

    const targetItem = flatItems[newIndex]
    const newParentId = targetItem ? targetItem.page.parentId : null

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

  const draggedItem = dragId ? flatItems.find((i) => i.page.id === dragId) : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={(e) => void handleDragEnd(e)}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className={styles.tree}>
          {flatItems.map(({ page, depth, hasChildren }) => (
            <SortablePageNode
              key={page.id}
              page={page}
              depth={searchQuery ? 0 : depth}
              hasChildren={hasChildren}
              isCollapsed={collapsed.has(page.id)}
              onToggleCollapse={() => toggleCollapse(page.id)}
              projectId={projectId}
              isActive={page.id === activePageId}
              isDragging={page.id === dragId}
              menuOpen={menuOpenId === page.id}
              onMenuToggle={() => setMenuOpenId(menuOpenId === page.id ? null : page.id)}
              menuRef={menuOpenId === page.id ? menuRef : undefined}
              onRefresh={onRefresh}
              onMenuClose={() => setMenuOpenId(null)}
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
  depth,
  hasChildren,
  isCollapsed,
  onToggleCollapse,
  projectId,
  isActive,
  isDragging,
  menuOpen,
  onMenuToggle,
  menuRef,
  onRefresh,
  onMenuClose,
}: {
  page: DocPageDTO
  depth: number
  hasChildren: boolean
  isCollapsed: boolean
  onToggleCollapse: () => void
  projectId: string
  isActive: boolean
  isDragging: boolean
  menuOpen: boolean
  onMenuToggle: () => void
  menuRef?: React.RefObject<HTMLDivElement | null>
  onRefresh: () => Promise<void>
  onMenuClose: () => void
}): React.ReactElement {
  const navigate = useNavigate()

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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${styles.nodeRow} ${isActive ? styles.nodeRowActive : ''}`}
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
        onClick={(e) => { e.stopPropagation(); onMenuToggle() }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="6" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="18" r="1.5" />
        </svg>
      </button>

      {/* Context menu */}
      {menuOpen && (
        <div className={styles.menu} ref={menuRef as React.RefObject<HTMLDivElement>}>
          <button className={`${styles.menuItem} ${styles.danger}`} onClick={() => void handleDelete()}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
