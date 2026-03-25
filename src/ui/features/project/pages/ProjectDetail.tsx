import { useState, useCallback, useEffect } from 'react'
import { useParams, useNavigate, Outlet, Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { api, type ProjectDTO, type DocPageDTO } from '../../../shared/api/client.js'
import { PageTree } from '../../page/components/PageTree.js'
import styles from './ProjectDetail.module.css'

export function ProjectDetail(): React.ReactElement {
  const { projectId, pageId } = useParams<{ projectId: string; pageId?: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<ProjectDTO | null>(null)
  const [pages, setPages] = useState<DocPageDTO[]>([])
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    if (!projectId) return
    try {
      const [proj, tree] = await Promise.all([
        api.projects.get(projectId),
        api.pages.list(projectId),
      ])
      setProject(proj)
      setPages(tree)
    } catch {
      // handled below
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void fetchData() }, [fetchData])

  if (loading) {
    return <Shell><Spinner size="lg" /></Shell>
  }

  if (!project) {
    return <Shell><EmptyState title="Project not found" /></Shell>
  }

  return (
    <Shell
      actions={
        <Link to="/">
          <Button size="sm" variant="ghost">&larr; Projects</Button>
        </Link>
      }
    >
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <span className={styles.projectName}>{project.name}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate(`/projects/${projectId}/pages/new`)}
            >
              +
            </Button>
          </div>
          <PageTree pages={pages} projectId={projectId!} activePageId={pageId} />
        </aside>

        <div className={pageId ? styles.content : styles.emptyContent}>
          {pageId ? (
            <Outlet context={{ project, pages, refetchPages: fetchData }} />
          ) : (
            <EmptyState
              title="Select a page"
              description="Choose a page from the sidebar or create a new one."
              action={
                <Button onClick={() => navigate(`/projects/${projectId}/pages/new`)}>
                  New Page
                </Button>
              }
            />
          )}
        </div>
      </div>
    </Shell>
  )
}
