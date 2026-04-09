import { useState, useCallback, useEffect, useRef } from 'react'
import { useParams, useNavigate, Outlet, useLocation, Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { type ProjectDTO, type DocPageDTO } from '../../../shared/api/client.js'
import { fetchProject, fetchPageTree } from '../../../shared/api/db.js'
import { PageTree } from '../../page/components/PageTree.js'
import { ChatPanel } from '../../chat/components/ChatPanel.js'
import { SharePanel } from '../../page/components/SharePanel.js'
import styles from './ProjectDetail.module.css'

type NavTab = 'pages' | 'chat' | 'share' | 'settings'

const NAV_ITEMS: { id: NavTab; label: string; d: string }[] = [
  { id: 'pages', label: 'Pages', d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' },
  { id: 'chat', label: 'Chat', d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
  { id: 'share', label: 'Share', d: 'M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13' },
  { id: 'settings', label: 'Settings', d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
]

export function ProjectDetail(): React.ReactElement {
  const { projectId, pageId } = useParams<{ projectId: string; pageId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [project, setProject] = useState<ProjectDTO | null>(null)
  const [pages, setPages] = useState<DocPageDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<NavTab>('pages')
  const switchRef = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState({ left: 0, width: 0 })

  const fetchData = useCallback(async () => {
    if (!projectId) return
    try {
      const [proj, tree] = await Promise.all([fetchProject(projectId), fetchPageTree(projectId)])
      setProject(proj)
      setPages(tree)
    } catch { /* handled */ }
    finally { setLoading(false) }
  }, [projectId])

  useEffect(() => { void fetchData() }, [fetchData])

  // Animate pill
  useEffect(() => {
    if (!switchRef.current) return
    const el = switchRef.current.querySelector(`[data-tab="${activeTab}"]`) as HTMLElement | null
    if (el) {
      const rect = el.getBoundingClientRect()
      const parentRect = switchRef.current.getBoundingClientRect()
      setPill({ left: rect.left - parentRect.left, width: rect.width })
    }
  }, [activeTab])

  // Sync settings route
  useEffect(() => {
    if (location.pathname.includes('/settings')) setActiveTab('settings')
    else if (activeTab === 'settings') setActiveTab('pages')
  }, [location.pathname])

  const handleTab = (tab: NavTab): void => {
    if (tab === 'settings') navigate(`/projects/${projectId}/settings`)
    else if (activeTab === 'settings') navigate(`/projects/${projectId}`)
    setActiveTab(tab)
  }

  if (loading) return <Shell fullWidth><div className={styles.loadingState}><Spinner size="lg" /></div></Shell>
  if (!project) return <Shell fullWidth><EmptyState title="Project not found" /></Shell>

  const isOnChildRoute = location.pathname !== `/projects/${projectId}` && !location.pathname.includes('/settings')
  const showPanel = activeTab === 'chat' || activeTab === 'share'

  // Switch bar rendered in the topbar
  const switchBar = (
    <div className={styles.switchBar} ref={switchRef}>
      <div className={styles.switchPill} style={{ left: pill.left, width: pill.width }} />
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          data-tab={item.id}
          className={`${styles.switchItem} ${activeTab === item.id ? styles.switchItemActive : ''}`}
          onClick={() => handleTab(item.id)}
          title={item.label}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d={item.d} />
          </svg>
          {activeTab === item.id && <span className={styles.switchLabel}>{item.label}</span>}
        </button>
      ))}
    </div>
  )

  return (
    <Shell
      fullWidth
      actions={
        <div className={styles.topbarActions}>
          <Link to="/" className={styles.breadcrumb}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Projects
          </Link>
          <span className={styles.breadcrumbSep}>/</span>
          <span className={styles.breadcrumbProject}>{project.name}</span>
        </div>
      }
      navBar={switchBar}
    >
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarActions}>
            <button className={styles.actionBtn} onClick={() => navigate(`/projects/${projectId}/pages/new`)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New page
            </button>
          </div>
          <div className={styles.pageList}>
            {pages.length > 0 ? (
              <PageTree pages={pages} projectId={projectId!} activePageId={pageId} onRefresh={fetchData} />
            ) : (
              <div className={styles.emptyPages}>
                <span>No pages yet</span>
                <Button size="sm" onClick={() => navigate(`/projects/${projectId}/pages/new`)}>Create first page</Button>
              </div>
            )}
          </div>
        </aside>

        <div className={`${styles.contentArea} ${showPanel ? styles.contentSplit : ''}`}>
          <div className={isOnChildRoute || activeTab === 'settings' ? styles.content : styles.emptyContent}>
            {isOnChildRoute ? (
              <Outlet context={{ project, pages, refetchPages: fetchData }} />
            ) : activeTab === 'settings' ? (
              <Outlet context={{ project, pages, refetchPages: fetchData }} />
            ) : (
              <EmptyState
                title={pages.length === 0 ? 'No pages yet' : 'Select a page'}
                description={
                  pages.length === 0
                    ? 'Create your first documentation page to get started.'
                    : 'Choose a page from the sidebar to view or edit its documentation.'
                }
                action={<Button onClick={() => navigate(`/projects/${projectId}/pages/new`)}>New Page</Button>}
              />
            )}
          </div>

          {showPanel && (
            <div className={styles.sidePanel}>
              {activeTab === 'chat' && <ChatPanel projectId={projectId!} projectName={project.name} onClose={() => handleTab('pages')} inline />}
              {activeTab === 'share' && <SharePanel project={project} onClose={() => handleTab('pages')} inline />}
            </div>
          )}
        </div>
      </div>
    </Shell>
  )
}
