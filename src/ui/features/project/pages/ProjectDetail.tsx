import { useState, useCallback, useEffect } from 'react'
import { useParams, useNavigate, Outlet, useLocation, Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { type ProjectDTO, type DocPageDTO } from '../../../shared/api/client.js'
import { fetchProject, fetchPageTree } from '../../../shared/api/db.js'
import { PageTree } from '../../page/components/PageTree.js'
import { computeThemeVars } from '../../../shared/theme/computeTheme.js'
import { useTheme } from '../../../shared/hooks/useTheme.js'
import styles from './ProjectDetail.module.css'

type NavTab = 'pages' | 'chat' | 'share' | 'design' | 'settings'

const ROUTE_TABS: NavTab[] = ['chat', 'share', 'design', 'settings']

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

function tabFromPath(pathname: string): NavTab | null {
  for (const tab of ROUTE_TABS) {
    if (pathname.includes(`/${tab}`)) return tab
  }
  return null
}

export function ProjectDetail(): React.ReactElement {
  const { projectId, pageId } = useParams<{ projectId: string; pageId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [project, setProject] = useState<ProjectDTO | null>(null)
  const [pages, setPages] = useState<DocPageDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<NavTab>('pages')

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

  // Sync tab from URL
  useEffect(() => {
    const tab = tabFromPath(location.pathname)
    if (tab) setActiveTab(tab)
    else setActiveTab('pages')
  }, [location.pathname])

  const handleTab = (tab: NavTab): void => {
    if (ROUTE_TABS.includes(tab)) {
      navigate(`/projects/${projectId}/${tab}`)
    } else {
      // "pages" — go back to project root
      if (activeTab !== 'pages') navigate(`/projects/${projectId}`)
    }
    setActiveTab(tab)
  }

  if (loading) return <Shell fullWidth><div className={styles.loadingState}><Spinner size="lg" /></div></Shell>
  if (!project) return <Shell fullWidth><EmptyState title="Project not found" /></Shell>

  const routeTab = tabFromPath(location.pathname)
  const isOnChildRoute = !routeTab && location.pathname !== `/projects/${projectId}`
  const showOutlet = isOnChildRoute || routeTab !== null

  const { theme } = useTheme()
  const design = project.design
  const themeStyle = design ? computeThemeVars(design, theme === 'dark') : undefined

  // Switch bar
  const switchBar = (
    <div className={styles.switchBar}>
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          className={`${styles.switchItem} ${activeTab === item.id ? styles.switchItemActive : ''}`}
          onClick={() => handleTab(item.id)}
          title={item.label}
        >
          {NAV_ICONS[item.id]}
          <span className={styles.switchLabel}>{item.label}</span>
        </button>
      ))}
    </div>
  )

  return (
    <div style={themeStyle}>
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
          <div className={showOutlet ? styles.content : styles.emptyContent}>
            {showOutlet ? (
              <Outlet context={{ project, setProject, pages, refetchPages: fetchData }} />
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
    </div>
  )
}
