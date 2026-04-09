import { useState, useCallback, useEffect } from 'react'
import { useParams, useNavigate, Outlet, useLocation, Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { type ProjectDTO, type DocPageDTO } from '../../../shared/api/client.js'
import { fetchProject, fetchPageTree } from '../../../shared/api/db.js'
import { PageTree } from '../../page/components/PageTree.js'
import { ChatPanel } from '../../chat/components/ChatPanel.js'
import { SharePanel } from '../../page/components/SharePanel.js'
import styles from './ProjectDetail.module.css'

type NavTab = 'pages' | 'chat' | 'share' | 'design' | 'settings'

/* Proper Lucide-quality multi-path icons */
const NAV_ICONS: Record<NavTab, React.ReactNode> = {
  pages: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 13h4" />
      <path d="M10 17h4" />
    </svg>
  ),
  chat: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  ),
  share: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  ),
  design: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </svg>
  ),
  settings: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
}

const NAV_ITEMS: { id: NavTab; label: string }[] = [
  { id: 'pages', label: 'Pages' },
  { id: 'chat', label: 'Chat' },
  { id: 'share', label: 'Share' },
  { id: 'design', label: 'Design' },
  { id: 'settings', label: 'Settings' },
]

export function ProjectDetail(): React.ReactElement {
  const { projectId, pageId } = useParams<{ projectId: string; pageId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [project, setProject] = useState<ProjectDTO | null>(null)
  const [pages, setPages] = useState<DocPageDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<NavTab>('pages')
  const [overlay, setOverlay] = useState<'chat' | 'share' | null>(null)

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

  // Sync tab with route
  useEffect(() => {
    if (location.pathname.includes('/settings')) {
      setActiveTab('settings')
      setOverlay(null)
    } else if (location.pathname.includes('/design')) {
      setActiveTab('design')
      setOverlay(null)
    } else if (activeTab === 'settings' || activeTab === 'design') {
      setActiveTab('pages')
    }
  }, [location.pathname])

  const handleTab = (tab: NavTab): void => {
    if (tab === 'chat' || tab === 'share') {
      // Toggle overlay
      if (overlay === tab) {
        setOverlay(null)
        setActiveTab('pages')
      } else {
        setOverlay(tab)
        setActiveTab(tab)
        // Navigate back from route tabs if needed
        if (location.pathname.includes('/settings') || location.pathname.includes('/design')) {
          navigate(`/projects/${projectId}`)
        }
      }
      return
    }

    // Close overlay when switching to pages/design/settings
    setOverlay(null)

    if (tab === 'settings') {
      navigate(`/projects/${projectId}/settings`)
    } else if (tab === 'design') {
      navigate(`/projects/${projectId}/design`)
    } else if (activeTab === 'settings' || activeTab === 'design') {
      navigate(`/projects/${projectId}`)
    }
    setActiveTab(tab)
  }

  if (loading) return <Shell fullWidth><div className={styles.loadingState}><Spinner size="lg" /></div></Shell>
  if (!project) return <Shell fullWidth><EmptyState title="Project not found" /></Shell>

  const isOnChildRoute = location.pathname !== `/projects/${projectId}` && !location.pathname.includes('/settings') && !location.pathname.includes('/design')
  const isRouteTab = location.pathname.includes('/settings') || location.pathname.includes('/design')

  // Switch bar in the topbar
  const switchBar = (
    <div className={styles.switchBar}>
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          className={`${styles.switchItem} ${activeTab === item.id ? styles.switchItemActive : ''}`}
          onClick={() => handleTab(item.id)}
        >
          {NAV_ICONS[item.id]}
          <span className={styles.switchLabel}>{item.label}</span>
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
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5v14" /></svg>
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

        <div className={styles.contentArea}>
          {/* Overlay panels — drop down from top */}
          {overlay && (
            <>
              <div className={styles.overlayBackdrop} onClick={() => { setOverlay(null); setActiveTab('pages') }} />
              <div className={styles.overlayPanel}>
                <div className={styles.overlayHeader}>
                  <span className={styles.overlayTitle}>
                    {overlay === 'chat' ? 'Chat with docs' : 'Share & Integrate'}
                  </span>
                  <button className={styles.overlayClose} onClick={() => { setOverlay(null); setActiveTab('pages') }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                  </button>
                </div>
                <div className={styles.overlayBody}>
                  {overlay === 'chat' && <ChatPanel projectId={projectId!} projectName={project.name} onClose={() => { setOverlay(null); setActiveTab('pages') }} inline />}
                  {overlay === 'share' && <SharePanel project={project} onClose={() => { setOverlay(null); setActiveTab('pages') }} inline />}
                </div>
              </div>
            </>
          )}

          {/* Main content */}
          <div className={isOnChildRoute || isRouteTab ? styles.content : styles.emptyContent}>
            {isOnChildRoute || isRouteTab ? (
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
        </div>
      </div>
    </Shell>
  )
}
