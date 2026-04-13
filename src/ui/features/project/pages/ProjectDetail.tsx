import { useState, useCallback, useEffect, useRef } from 'react'
import { useParams, useNavigate, Outlet, useLocation, Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { type ProjectDTO, type DocPageDTO } from '../../../shared/api/client.js'
import { fetchProject, fetchPageTree } from '../../../shared/api/db.js'
import { PageTree } from '../../page/components/PageTree.js'
import styles from './ProjectDetail.module.css'

type NavTab = 'pages' | 'chat' | 'share' | 'design' | 'settings'

const ROUTE_TABS: NavTab[] = ['chat', 'share', 'design', 'settings']

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
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  ),
  design: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="8" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="11.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="11.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="10" cy="15.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="14" cy="15.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 21v-1a4 4 0 0 1 4-4h4" /><circle cx="9" cy="8" r="4" />
      <circle cx="18" cy="18" r="3" /><path d="M18 15v6" /><path d="M15 18h6" />
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
