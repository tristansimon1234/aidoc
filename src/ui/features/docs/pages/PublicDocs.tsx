import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { Spinner, EmptyState } from '../../../design-system/components/index.js'
import { MarkdownRenderer } from '../../../design-system/components/index.js'
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
            const q = search.toLowerCase()
            const results = pages.filter((p) => p.title.toLowerCase().includes(q) || p.content?.toLowerCase().includes(q)).slice(0, 8)
            return (
              <div className={styles.searchDropdown}>
                {results.length === 0 ? (
                  <div className={styles.searchEmpty}>No results</div>
                ) : results.map((p) => (
                  <button key={p.id} className={styles.searchResult} onClick={() => { setActivePage(p); setSearch(''); setSearchFocused(false) }}>
                    {p.title}
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
            {pages.map((p) => (
              <button
                key={p.id}
                className={`${styles.navItem} ${activePage?.id === p.id ? styles.navItemActive : ''}`}
                onClick={() => setActivePage(p)}
              >
                {p.title}
              </button>
            ))}
          </nav>
        </aside>

        <div className={styles.contentWrapper}>
          <div className={styles.content}>
            {activePage && (
              <>
                <h1 className={styles.pageTitle}>{activePage.title}</h1>
                {activePage.content ? (
                  <MarkdownRenderer content={activePage.content} />
                ) : (
                  <p className={styles.empty}>This page has no content yet.</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
