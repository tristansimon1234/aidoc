import { Link } from 'react-router-dom'
import type { DocPageDTO } from '../../../shared/api/client.js'
import styles from './PageTree.module.css'

interface PageTreeProps {
  pages: DocPageDTO[]
  projectId: string
  activePageId?: string
}

export function PageTree({ pages, projectId, activePageId }: PageTreeProps): React.ReactElement {
  return (
    <div className={styles.tree}>
      {pages.map((page) => (
        <PageNode
          key={page.id}
          page={page}
          projectId={projectId}
          activePageId={activePageId}
        />
      ))}
    </div>
  )
}

function PageNode({
  page,
  projectId,
  activePageId,
}: {
  page: DocPageDTO
  projectId: string
  activePageId?: string
}): React.ReactElement {
  const isActive = page.id === activePageId
  const cls = `${styles.node} ${isActive ? styles.active : ''}`

  return (
    <>
      <Link to={`/projects/${projectId}/pages/${page.id}`} className={cls}>
        <span className={`${styles.statusDot} ${styles[page.status]}`} />
        <span className={styles.label}>{page.title}</span>
      </Link>
      {page.children && page.children.length > 0 && (
        <div className={styles.children}>
          {page.children.map((child) => (
            <PageNode
              key={child.id}
              page={child}
              projectId={projectId}
              activePageId={activePageId}
            />
          ))}
        </div>
      )}
    </>
  )
}
