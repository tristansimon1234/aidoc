import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { DocPageDTO } from '../../../shared/api/client.js'
import { api } from '../../../shared/api/client.js'
import styles from './PageTree.module.css'

interface PageTreeProps {
  pages: DocPageDTO[]
  projectId: string
  activePageId?: string
  allPagesFlat?: DocPageDTO[]
  onRefresh: () => Promise<void>
}

function flattenPages(pages: DocPageDTO[]): DocPageDTO[] {
  const result: DocPageDTO[] = []
  for (const p of pages) {
    result.push(p)
    if (p.children) result.push(...flattenPages(p.children))
  }
  return result
}

export function PageTree({ pages, projectId, activePageId, onRefresh }: PageTreeProps): React.ReactElement {
  const allFlat = flattenPages(pages)

  return (
    <div className={styles.tree}>
      {pages.map((page) => (
        <PageNode
          key={page.id}
          page={page}
          projectId={projectId}
          activePageId={activePageId}
          allPagesFlat={allFlat}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  )
}

function PageNode({
  page,
  projectId,
  activePageId,
  allPagesFlat,
  onRefresh,
}: {
  page: DocPageDTO
  projectId: string
  activePageId?: string
  allPagesFlat: DocPageDTO[]
  onRefresh: () => Promise<void>
}): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const navigate = useNavigate()
  const isActive = page.id === activePageId
  const cls = `${styles.node} ${isActive ? styles.active : ''}`

  const handleMoveUp = async (): Promise<void> => {
    await api.pages.update(projectId, page.id, { sortOrder: Math.max(0, page.sortOrder - 1) })
    await onRefresh()
    setMenuOpen(false)
  }

  const handleMoveDown = async (): Promise<void> => {
    await api.pages.update(projectId, page.id, { sortOrder: page.sortOrder + 1 })
    await onRefresh()
    setMenuOpen(false)
  }

  const handleMoveTo = async (newParentId: string | null): Promise<void> => {
    await api.pages.update(projectId, page.id, { parentId: newParentId })
    await onRefresh()
    setMoveOpen(false)
    setMenuOpen(false)
  }

  const handleDelete = async (): Promise<void> => {
    await api.pages.delete(projectId, page.id)
    await onRefresh()
    navigate(`/projects/${projectId}`)
    setMenuOpen(false)
  }

  return (
    <>
      <div className={styles.nodeRow}>
        <Link to={`/projects/${projectId}/pages/${page.id}`} className={cls}>
          <span className={`${styles.statusDot} ${styles[page.status]}`} />
          <span className={styles.label}>{page.title}</span>
        </Link>
        <button
          className={styles.menuBtn}
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
        >
          ...
        </button>
      </div>

      {menuOpen && (
        <div className={styles.menu}>
          <button className={styles.menuItem} onClick={() => void handleMoveUp()}>Move up</button>
          <button className={styles.menuItem} onClick={() => void handleMoveDown()}>Move down</button>
          <button className={styles.menuItem} onClick={() => { setMoveOpen(!moveOpen); }}>
            Move to...
          </button>
          <button className={`${styles.menuItem} ${styles.danger}`} onClick={() => void handleDelete()}>
            Delete
          </button>
        </div>
      )}

      {moveOpen && (
        <div className={styles.moveList}>
          <button
            className={styles.moveItem}
            onClick={() => void handleMoveTo(null)}
          >
            (top level)
          </button>
          {allPagesFlat
            .filter((p) => p.id !== page.id)
            .map((p) => (
              <button
                key={p.id}
                className={styles.moveItem}
                onClick={() => void handleMoveTo(p.id)}
              >
                {p.title}
              </button>
            ))}
        </div>
      )}

      {page.children && page.children.length > 0 && (
        <div className={styles.children}>
          {page.children.map((child) => (
            <PageNode
              key={child.id}
              page={child}
              projectId={projectId}
              activePageId={activePageId}
              allPagesFlat={allPagesFlat}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </>
  )
}
