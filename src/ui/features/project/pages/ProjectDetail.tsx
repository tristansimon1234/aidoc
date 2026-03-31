import { useState, useCallback, useEffect } from 'react'
import { useParams, useNavigate, Outlet, useLocation, Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { api, type ProjectDTO, type DocPageDTO } from '../../../shared/api/client.js'
import { PageTree } from '../../page/components/PageTree.js'
import styles from './ProjectDetail.module.css'

export function ProjectDetail(): React.ReactElement {
  const { projectId, pageId } = useParams<{ projectId: string; pageId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [project, setProject] = useState<ProjectDTO | null>(null)
  const [pages, setPages] = useState<DocPageDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)

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

  const handleAutoGenerate = async (): Promise<void> => {
    if (!projectId) return
    setGenerating(true)
    try {
      await api.pages.autoGenerate(projectId)
      await fetchData()
    } catch (err) {
      console.error('Auto-generate failed:', err)
    } finally {
      setGenerating(false)
    }
  }

  if (loading) {
    return <Shell fullWidth><Spinner size="lg" /></Shell>
  }

  if (!project) {
    return <Shell fullWidth><EmptyState title="Project not found" /></Shell>
  }

  const isOnChildRoute = location.pathname !== `/projects/${projectId}`

  return (
    <Shell
      fullWidth
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
            <div className={styles.headerActions}>
              <button
                className={styles.headerBtn}
                onClick={() => navigate(`/projects/${projectId}/settings`)}
                title="Project settings"
              >
                &#9881;
              </button>
              <button
                className={styles.headerBtnPrimary}
                onClick={() => navigate(`/projects/${projectId}/pages/new`)}
                title="Add page"
              >
                +
              </button>
            </div>
          </div>
          <div className={styles.pageList}>
            {pages.length > 0 ? (
              <PageTree pages={pages} projectId={projectId!} activePageId={pageId} onRefresh={fetchData} />
            ) : (
              <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', padding: 'var(--space-sm)' }}>
                No pages yet
              </p>
            )}
          </div>
        </aside>

        <div className={isOnChildRoute ? styles.content : styles.emptyContent}>
          {isOnChildRoute ? (
            <Outlet context={{ project, pages, refetchPages: fetchData }} />
          ) : (
            <EmptyState
              title={pages.length === 0 ? 'Get started' : 'Select a page'}
              description={
                pages.length === 0
                  ? 'Let the AI scan your site and create a documentation structure automatically.'
                  : 'Choose a page from the sidebar to view or edit its documentation.'
              }
              action={
                pages.length === 0 ? (
                  <div style={{ display: 'flex', gap: 'var(--space-sm)', flexDirection: 'column', alignItems: 'center' }}>
                    <Button
                      onClick={() => void handleAutoGenerate()}
                      disabled={generating}
                    >
                      {generating ? 'Scanning site...' : 'Auto-generate structure'}
                    </Button>
                    <Button variant="ghost" onClick={() => navigate(`/projects/${projectId}/pages/new`)}>
                      Or create pages manually
                    </Button>
                  </div>
                ) : (
                  <Button onClick={() => navigate(`/projects/${projectId}/pages/new`)}>
                    New Page
                  </Button>
                )
              }
            />
          )}
        </div>
      </div>
    </Shell>
  )
}
