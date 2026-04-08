import { useState, useCallback, useEffect } from 'react'
import { useParams, useNavigate, Outlet, useLocation, Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { type ProjectDTO, type DocPageDTO } from '../../../shared/api/client.js'
import { fetchProject, fetchPageTree } from '../../../shared/api/db.js'
import { PageTree } from '../../page/components/PageTree.js'
import { ChatPanel } from '../../chat/components/ChatPanel.js'
import styles from './ProjectDetail.module.css'

export function ProjectDetail(): React.ReactElement {
  const { projectId, pageId } = useParams<{ projectId: string; pageId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [project, setProject] = useState<ProjectDTO | null>(null)
  const [pages, setPages] = useState<DocPageDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [chatOpen, setChatOpen] = useState(false)

  const fetchData = useCallback(async () => {
    if (!projectId) return
    try {
      const [proj, tree] = await Promise.all([
        fetchProject(projectId),
        fetchPageTree(projectId),
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
    return <Shell fullWidth><div className={styles.loadingState}><Spinner size="lg" /></div></Shell>
  }

  if (!project) {
    return <Shell fullWidth><EmptyState title="Project not found" /></Shell>
  }

  const isOnChildRoute = location.pathname !== `/projects/${projectId}`

  return (
    <Shell
      fullWidth
      actions={
        <Link to="/" className={styles.breadcrumb}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          Projects
        </Link>
      }
    >
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <span className={styles.projectName}>{project.name}</span>
          </div>

          <div className={styles.sidebarActions}>
            <button className={styles.actionBtn} onClick={() => navigate(`/projects/${projectId}/pages/new`)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New page
            </button>
          </div>

          <div className={styles.sidebarLabel}>Pages</div>

          <div className={styles.pageList}>
            {pages.length > 0 ? (
              <PageTree pages={pages} projectId={projectId!} activePageId={pageId} onRefresh={fetchData} />
            ) : (
              <div className={styles.emptyPages}>
                <span>No pages yet</span>
                <Button size="sm" onClick={() => navigate(`/projects/${projectId}/pages/new`)}>
                  Create first page
                </Button>
              </div>
            )}
          </div>

          <div className={styles.sidebarFooter}>
            <button className={styles.footerBtn} onClick={() => setChatOpen(true)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              Chat with docs
            </button>
            <button className={styles.footerBtn} onClick={() => navigate(`/projects/${projectId}/settings`)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              Settings
            </button>
          </div>
        </aside>

        <div className={isOnChildRoute ? styles.content : styles.emptyContent}>
          {isOnChildRoute ? (
            <Outlet context={{ project, pages, refetchPages: fetchData }} />
          ) : (
            <EmptyState
              title={pages.length === 0 ? 'No pages yet' : 'Select a page'}
              description={
                pages.length === 0
                  ? 'Create your first documentation page to get started.'
                  : 'Choose a page from the sidebar to view or edit its documentation.'
              }
              action={
                <Button onClick={() => navigate(`/projects/${projectId}/pages/new`)}>
                  New Page
                </Button>
              }
            />
          )}
        </div>
      </div>
      {chatOpen && <ChatPanel projectId={projectId!} projectName={project.name} onClose={() => setChatOpen(false)} />}
    </Shell>
  )
}
