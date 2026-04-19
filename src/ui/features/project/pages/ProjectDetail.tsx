import { useState, useCallback, useEffect, useRef } from 'react'
import { useParams, useNavigate, Outlet, useLocation, Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { useLoadJobsFromDB } from '../../../shared/jobs/useJobRealtime.js'
import { Button, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { type ProjectDTO, type DocPageDTO } from '../../../shared/api/client.js'
import { fetchProject, fetchPageTree } from '../../../shared/api/db.js'
import { PageTree } from '../../page/components/PageTree.js'
import styles from './ProjectDetail.module.css'

type NavTab = 'pages' | 'chat' | 'share' | 'design' | 'analytics' | 'activity' | 'settings'

const ROUTE_TABS: NavTab[] = ['chat', 'share', 'design', 'analytics', 'activity', 'settings']

/* Modern nav icons — semi-filled style */
const NAV_ICONS: Record<NavTab, React.ReactNode> = {
  pages: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.342a2 2 0 0 0-.602-1.43l-4.44-4.342A2 2 0 0 0 13.56 2H6a2 2 0 0 0-2 2z" />
      <path d="M9 13h6" /><path d="M9 17h4" /><path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  ),
  chat: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2C6.477 2 2 6.015 2 10.97c0 2.735 1.329 5.175 3.406 6.813.118.093.2.236.2.394L5.4 20.6a.85.85 0 0 0 1.254.745l2.663-1.472a.85.85 0 0 1 .562-.088c.7.14 1.426.215 2.171.215 5.523 0 10-4.015 10-8.97C22 6.015 17.523 2 12 2z" />
      <path d="M8 11h.01" /><path d="M12 11h.01" /><path d="M16 11h.01" />
    </svg>
  ),
  share: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  ),
  design: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
      <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
    </svg>
  ),
  analytics: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="20" x2="21" y2="20" />
      <rect x="6" y="10" width="3" height="8" rx="0.5" />
      <rect x="11" y="6" width="3" height="12" rx="0.5" />
      <rect x="16" y="13" width="3" height="5" rx="0.5" />
    </svg>
  ),
  activity: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
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
  { id: 'analytics', label: 'Analytics' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
]

function tabFromPath(pathname: string): NavTab | null {
  for (const tab of ROUTE_TABS) {
    if (pathname.includes(`/${tab}`)) return tab
  }
  return null
}

// --- Search helper: search titles + content ---
interface SearchResult { page: DocPageDTO; snippet: string }

function searchPages(pages: DocPageDTO[], query: string): SearchResult[] {
  if (!query || query.length < 2) return []
  const q = query.toLowerCase()
  const results: SearchResult[] = []
  for (const p of pages) {
    if (p.title.toLowerCase().includes(q)) {
      results.push({ page: p, snippet: p.title })
    } else if (p.content?.toLowerCase().includes(q)) {
      const idx = p.content.toLowerCase().indexOf(q)
      const start = Math.max(0, idx - 40)
      const end = Math.min(p.content.length, idx + query.length + 40)
      const raw = p.content.slice(start, end).replace(/[#*_\[\]]/g, '')
      results.push({ page: p, snippet: (start > 0 ? '...' : '') + raw + (end < p.content.length ? '...' : '') })
    }
  }
  return results.slice(0, 8)
}

export function ProjectDetail(): React.ReactElement {
  const { projectId, pageId } = useParams<{ projectId: string; pageId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [project, setProject] = useState<ProjectDTO | null>(null)
  const [pages, setPages] = useState<DocPageDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<NavTab>('pages')
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)

  // Restore running jobs from DB (survives browser refresh)
  useLoadJobsFromDB(projectId)

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

  // Close search on outside click
  useEffect(() => {
    if (!searchFocused) return
    const handler = (e: MouseEvent): void => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchFocused(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [searchFocused])

  const handleTab = (tab: NavTab): void => {
    if (ROUTE_TABS.includes(tab)) {
      navigate(`/projects/${projectId}/${tab}`)
    } else {
      if (activeTab !== 'pages') navigate(`/projects/${projectId}`)
    }
    setActiveTab(tab)
  }

  if (loading) return <Shell fullWidth><div className={styles.loadingState}><Spinner size="lg" /></div></Shell>
  if (!project) return <Shell fullWidth><EmptyState title="Project not found" /></Shell>

  const routeTab = tabFromPath(location.pathname)
  const isOnChildRoute = !routeTab && location.pathname !== `/projects/${projectId}`
  const showOutlet = isOnChildRoute || routeTab !== null
  const searchResults = searchPages(pages, search)

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

          {/* Search in topbar */}
          <div className={styles.searchWrapper} ref={searchRef}>
            <div className={`${styles.searchBar} ${searchFocused ? styles.searchBarFocused : ''}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
              <input
                className={styles.searchInput}
                placeholder="Search docs..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onFocus={() => setSearchFocused(true)}
              />
              {search && (
                <button className={styles.searchClear} onClick={() => { setSearch(''); setSearchFocused(false) }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                </button>
              )}
            </div>
            {searchFocused && search.length >= 2 && (
              <div className={styles.searchDropdown}>
                {searchResults.length === 0 ? (
                  <div className={styles.searchEmpty}>No results</div>
                ) : (
                  searchResults.map((r) => (
                    <button
                      key={r.page.id}
                      className={styles.searchResult}
                      onClick={() => {
                        navigate(`/projects/${projectId}/pages/${r.page.id}`)
                        setSearch('')
                        setSearchFocused(false)
                      }}
                    >
                      <span className={styles.searchResultTitle}>{r.page.title}</span>
                      <span className={styles.searchResultSnippet}>{r.snippet}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      }
      navBar={switchBar}
    >
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <span className={styles.sidebarTitle}>Pages</span>
            <button className={styles.newPageBtn} onClick={() => navigate(`/projects/${projectId}/pages/new`)} title="New page">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5v14" /></svg>
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
  )
}
