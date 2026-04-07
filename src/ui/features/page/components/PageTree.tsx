import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
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
}

function flattenForSortable(pages: DocPageDTO[], depth: number = 0): { page: DocPageDTO; depth: number }[] {
  const result: { page: DocPageDTO; depth: number }[] = []
  for (const p of pages) {
    result.push({ page: p, depth })
    if (p.children && p.children.length > 0) {
      result.push(...flattenForSortable(p.children, depth + 1))
    }
  }
  return result
}

export function PageTree({ pages, projectId, activePageId, onRefresh }: PageTreeProps): React.ReactElement {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  const flatItems = flattenForSortable(pages)
  const ids = flatItems.map((item) => item.page.id)

  const handleDragEnd = async (event: DragEndEvent): Promise<void> => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = ids.indexOf(active.id as string)
    const newIndex = ids.indexOf(over.id as string)
    if (oldIndex === -1 || newIndex === -1) return

    // Build new ordering
    const reordered = [...flatItems]
    const [moved] = reordered.splice(oldIndex, 1)
    if (!moved) return
    reordered.splice(newIndex, 0, moved)

    // Determine new parent: adopt the parent of the item above
    const targetItem = flatItems[newIndex]
    const newParentId = targetItem ? targetItem.page.parentId : null

    // Build reorder payload
    const updates = reordered.map((item, i) => ({
      id: item.page.id,
      parentId: item.page.id === (active.id as string) ? newParentId : item.page.parentId,
      sortOrder: i,
    }))

    try {
      await reorderPages(projectId, updates)
      await onRefresh()
    } catch {
      // Revert on error
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(e) => void handleDragEnd(e)}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className={styles.tree}>
          {flatItems.map(({ page, depth }) => (
            <SortablePageNode
              key={page.id}
              page={page}
              depth={depth}
              projectId={projectId}
              isActive={page.id === activePageId}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

function SortablePageNode({
  page,
  depth,
  projectId,
  isActive,
  onRefresh,
}: {
  page: DocPageDTO
  depth: number
  projectId: string
  isActive: boolean
  onRefresh: () => Promise<void>
}): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const navigate = useNavigate()

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: page.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    paddingLeft: `${depth * 16 + 8}px`,
  }

  const handleDelete = async (): Promise<void> => {
    await deletePage(projectId, page.id)
    await onRefresh()
    navigate(`/projects/${projectId}`)
    setMenuOpen(false)
  }

  return (
    <div ref={setNodeRef} style={style} className={styles.nodeRow}>
      <span className={styles.dragHandle} {...attributes} {...listeners}>
        ⠿
      </span>
      <Link
        to={`/projects/${projectId}/pages/${page.id}`}
        className={`${styles.node} ${isActive ? styles.active : ''}`}
      >
        <span className={`${styles.statusDot} ${styles[page.status]}`} />
        <span className={styles.label}>{page.title}</span>
      </Link>
      <button
        className={styles.menuBtn}
        onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
      >
        ...
      </button>
      {menuOpen && (
        <div className={styles.menu}>
          <button className={`${styles.menuItem} ${styles.danger}`} onClick={() => void handleDelete()}>
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
