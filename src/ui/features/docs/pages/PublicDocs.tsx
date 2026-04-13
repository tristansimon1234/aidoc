import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { Spinner, EmptyState, MarkdownRenderer, TableOfContents } from '../../../design-system/components/index.js'
import type { ProjectDesignDTO } from '../../../shared/api/client.js'
import { computeFullTheme } from '../../../shared/theme/computeTheme.js'
import styles from './PublicDocs.module.css'

interface PublicPage {
  id: string
  title: string
  slug: string
  content: string | null
  parentId: string | null
  sortOrder: number
}

interface PublicProject {
  id: string
  name: string
  description: string | null
  design: ProjectDesignDTO | null
}

// --- Search helper: search titles + content (same as admin) ---
interface SearchResult { page: PublicPage; snippet: string }

function searchPages(pages: PublicPage[], query: string): SearchResult[] {
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

interface TreePage extends PublicPage {
  children: TreePage[]
}

function buildPageTree(pages: PublicPage[]): TreePage[] {
  const map = new Map<string, TreePage>()
  const roots: TreePage[] = []
  for (const p of pages) map.set(p.id, { ...p, children: [] })
  for (const p of pages) {
    const node = map.get(p.id)!
    if (p.parentId && map.has(p.parentId)) {
      map.get(p.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

function NavTree({ items, activePage, onSelect, depth = 0 }: {
  items: TreePage[]
  activePage: PublicPage | null
  onSelect: (page: PublicPage) => void
  depth?: number
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <>
      {items.map((p) => {
        const hasChildren = p.children.length > 0
        const isCollapsed = collapsed.has(p.id)
        return (
          <div key={p.id}>
            <div className={styles.navRow} style={{ paddingLeft: `${depth * 14 + 4}px` }}>
              {hasChildren ? (
                <button className={styles.navChevron} onClick={() => toggle(p.id)}>
                  <svg
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    style={{ transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.15s' }}
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              ) : (
                <span className={styles.navSpacer} />
              )}
              <button
                className={`${styles.navItem} ${activePage?.id === p.id ? styles.navItemActive : ''}`}
                onClick={() => onSelect(p)}
              >
                {p.title}
              </button>
            </div>
            {hasChildren && !isCollapsed && (
              <NavTree items={p.children} activePage={activePage} onSelect={onSelect} depth={depth + 1} />
            )}
          </div>
        )
      })}
    </>
  )
}

export function PublicDocs(): React.ReactElement {
  const { projectId } = useParams<{ projectId: string }>()
  const [project, setProject] = useState<PublicProject | null>(null)
  const [pages, setPages] = useState<PublicPage[]>([])
  const [activePage, setActivePage] = useState<PublicPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Close search on outside click
  useEffect(() => {
    if (!searchFocused) return
    const handler = (e: MouseEvent): void => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchFocused(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [searchFocused])

  useEffect(() => {
    if (!projectId) return
    void (async () => {
      try {
        const res = await fetch(`/api/docs/${projectId}`)
        if (!res.ok) throw new Error('Not found')
        const data = await res.json() as { project: PublicProject; pages: PublicPage[] }
        setProject(data.project)
        setPages(data.pages)
        if (data.pages.length > 0) setActivePage(data.pages[0] ?? null)
      } catch {
        setError('Documentation not found')
      } finally {
        setLoading(false)
      }
    })()
  }, [projectId])

  if (loading) {
    return <div className={styles.center}><Spinner size="lg" /></div>
  }

  if (error || !project) {
    return <div className={styles.center}><EmptyState title="Not found" description="This documentation doesn't exist or isn't published yet." /></div>
  }

  if (pages.length === 0) {
    return <div className={styles.center}><EmptyState title="No published pages" description="This project hasn't published any documentation yet." /></div>
  }

  const design = project.design
  const themeStyle = design ? computeFullTheme(design) : undefined

  return (
    <div className={styles.shell} style={themeStyle} data-theme="light">
      <header className={styles.topbar}>
        {project.design?.logoUrl ? (
          <img src={project.design.logoUrl} alt={project.name} className={styles.logoImg} />
        ) : null}
        <span className={styles.logo}>{project.name}</span>
        <span className={styles.badge}>Documentation</span>
        <div className={styles.searchWrapper} ref={searchRef}>
          <div className={`${styles.searchBar} ${searchFocused ? styles.searchBarFocused : ''}`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
            <input className={styles.searchInput} placeholder="Search docs..." value={search} onChange={(e) => setSearch(e.target.value)} onFocus={() => setSearchFocused(true)} />
            {search && (
              <button className={styles.searchClear} onClick={() => { setSearch(''); setSearchFocused(false) }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            )}
          </div>
          {searchFocused && search.length >= 2 && (() => {
            const results = searchPages(pages, search)
            return (
              <div className={styles.searchDropdown}>
                {results.length === 0 ? (
                  <div className={styles.searchEmpty}>No results</div>
                ) : results.map((r) => (
                  <button key={r.page.id} className={styles.searchResult} onClick={() => { setActivePage(r.page); setSearch(''); setSearchFocused(false) }}>
                    <span className={styles.searchResultTitle}>{r.page.title}</span>
                    <span className={styles.searchResultSnippet}>{r.snippet}</span>
                  </button>
                ))}
              </div>
            )
          })()}
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <nav className={styles.nav}>
            <NavTree items={buildPageTree(pages)} activePage={activePage} onSelect={setActivePage} />
          </nav>
        </aside>

        <div className={styles.contentWrapper} ref={contentRef}>
          <div className={styles.content}>
            {activePage && (
              <>
                <h1 className={styles.pageTitle}>{activePage.title}</h1>
                {activePage.content ? (
                  <MarkdownRenderer content={activePage.content} />
                ) : (
                  <p className={styles.empty}>This page has no content yet.</p>
                )}
                {/* Notion-style child page links */}
                {(() => {
                  const children = pages.filter((p) => p.parentId === activePage.id)
                  if (children.length === 0) return null
                  return (
                    <div className={styles.childPages}>
                      {children.map((child) => (
                        <button key={child.id} className={styles.childPageLink} onClick={() => setActivePage(child)}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.342a2 2 0 0 0-.602-1.43l-4.44-4.342A2 2 0 0 0 13.56 2H6a2 2 0 0 0-2 2z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></svg>
                          {child.title}
                        </button>
                      ))}
                    </div>
                  )
                })()}
              </>
            )}
          </div>
          {activePage?.content && (
            <TableOfContents content={activePage.content} scrollContainer={contentRef.current} />
          )}
        </div>
      </div>
    </div>
  )
}
