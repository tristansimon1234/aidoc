import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Spinner, EmptyState } from '../../../design-system/components/index.js'
import { MarkdownRenderer } from '../../../design-system/components/index.js'
import type { ProjectDesignDTO } from '../../../shared/api/client.js'
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
  const designVars: React.CSSProperties | undefined = design ? {
    '--doc-accent': design.accentColor,
    '--doc-bg': design.bgColor,
    '--doc-text': design.textColor,
    '--doc-font': design.font,
  } as React.CSSProperties : undefined

  return (
    <div className={styles.shell} style={designVars}>
      <header className={styles.topbar}>
        <span className={styles.logo}>{project.name}</span>
        <span className={styles.badge}>Documentation</span>
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
              <div className={styles.docArea}>
                <h1 className={styles.pageTitle}>{activePage.title}</h1>
                {activePage.content ? (
                  <MarkdownRenderer content={activePage.content} />
                ) : (
                  <p className={styles.empty}>This page has no content yet.</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
