import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Card, Spinner, EmptyState, useConfirmDialog } from '../../../design-system/components/index.js'
import { useAsync } from '../../../shared/hooks/useAsync.js'
import { fetchProjects, updateProject } from '../../../shared/api/db.js'
import type { ProjectDTO } from '../../../shared/api/client.js'
import styles from './ProjectList.module.css'

// `onSignOut` is now handled via the avatar menu in the left rail, but we keep
// the prop to avoid changing the App.tsx wiring in this PR.
interface ProjectListProps {
  onSignOut?: () => Promise<void>
}

export function ProjectList(_props: ProjectListProps): React.ReactElement {
  const navigate = useNavigate()
  const { data: projects, loading, error, refetch } = useAsync(() => fetchProjects())
  const { dialog: confirmDialog, confirm } = useConfirmDialog()
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const active = useMemo(() => (projects ?? []).filter((p) => !p.archivedAt), [projects])
  const archived = useMemo(() => (projects ?? []).filter((p) => Boolean(p.archivedAt)), [projects])

  const filtered = useMemo(() => {
    const source = showArchived ? archived : active
    const q = query.trim().toLowerCase()
    if (!q) return source
    return source.filter((p) => {
      const haystack = `${p.name} ${p.description ?? ''} ${p.baseUrl}`.toLowerCase()
      return haystack.includes(q)
    })
  }, [showArchived, archived, active, query])

  const handleArchive = async (e: React.MouseEvent, project: ProjectDTO): Promise<void> => {
    e.stopPropagation()
    const archiving = !project.archivedAt
    const ok = await confirm(archiving
      ? {
          title: `Archive "${project.name}"?`,
          message: 'It will disappear from your active list. You can restore it from the Archived view anytime.',
          confirmLabel: 'Archive',
          cancelLabel: 'Cancel',
          variant: 'danger',
        }
      : {
          title: `Restore "${project.name}"?`,
          message: 'This project will show up again in your active list.',
          confirmLabel: 'Restore',
          cancelLabel: 'Cancel',
          variant: 'primary',
        })
    if (!ok) return
    try {
      await updateProject(project.id, { archivedAt: archiving ? new Date().toISOString() : null })
      refetch()
    } catch (err) {
      await confirm({
        title: archiving ? 'Archive failed' : 'Restore failed',
        message: (err as Error).message,
        confirmLabel: 'OK',
        cancelLabel: 'Dismiss',
        variant: 'primary',
      })
    }
  }

  const hasAnyProject = (projects?.length ?? 0) > 0

  return (
    <Shell>
      {confirmDialog}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Projects</h1>
          {hasAnyProject && (
            <p className={styles.subtitle}>
              {showArchived ? `${archived.length} archived` : `${active.length} active`}
              {archived.length > 0 && !showArchived && ` · ${archived.length} archived`}
            </p>
          )}
        </div>
        <Link to="/projects/new">
          <Button size="sm">New Project</Button>
        </Link>
      </div>

      {hasAnyProject && (
        <div className={styles.toolbar}>
          <div className={styles.searchWrapper}>
            <svg
              className={styles.searchIcon}
              width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              className={styles.searchInput}
              placeholder="Search projects..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
            {query && (
              <button
                className={styles.searchClear}
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
              </button>
            )}
          </div>

          {archived.length > 0 && (
            <button
              className={`${styles.archiveToggle} ${showArchived ? styles.archiveToggleActive : ''}`}
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? 'Back to active' : `Archived (${archived.length})`}
            </button>
          )}
        </div>
      )}

      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-2xl)' }}><Spinner size="lg" /></div>}
      {error && <EmptyState title="Failed to load" description={error} />}

      {!loading && !hasAnyProject && (
        <div className={styles.welcome}>
          <div className={styles.welcomeContent}>
            <h2 className={styles.welcomeTitle}>
              Generate docs, deploy an AI chatbot.
            </h2>
            <p className={styles.welcomeDesc}>
              Upload a screen recording or let AI explore your app. Get professional documentation and an embeddable chat widget in minutes.
            </p>

            <div className={styles.features}>
              <div className={styles.feature}>
                <div className={styles.featureIcon} style={{ color: 'var(--color-success)' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m22 8-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
                </div>
                <div>
                  <p className={styles.featureTitle}>AI Documentation</p>
                  <p className={styles.featureDesc}>Upload a video, get a full product guide with screenshots</p>
                </div>
              </div>
              <div className={styles.feature}>
                <div className={styles.featureIcon} style={{ color: 'var(--color-primary)' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09z"/><path d="M18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456z"/></svg>
                </div>
                <div>
                  <p className={styles.featureTitle}>Embeddable Chat Widget</p>
                  <p className={styles.featureDesc}>Your users ask questions, AI answers from your docs</p>
                </div>
              </div>
              <div className={styles.feature}>
                <div className={styles.featureIcon} style={{ color: 'var(--color-warning)' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"/><path d="M3.6 9h16.8"/><path d="M3.6 15h16.8"/><path d="M12 3a15 15 0 0 1 4 9 15 15 0 0 1-4 9 15 15 0 0 1-4-9 15 15 0 0 1 4-9z"/></svg>
                </div>
                <div>
                  <p className={styles.featureTitle}>Auto-Exploration</p>
                  <p className={styles.featureDesc}>AI agent browses your app and writes docs autonomously</p>
                </div>
              </div>
            </div>

            <Link to="/projects/new">
              <Button>Create Your First Project</Button>
            </Link>
          </div>
        </div>
      )}

      {hasAnyProject && filtered.length === 0 && (
        <EmptyState
          title={query ? 'No matches' : showArchived ? 'No archived projects' : 'No active projects'}
          description={
            query
              ? `Nothing matches "${query}".`
              : showArchived
                ? 'Archived projects will appear here.'
                : 'All your projects are archived — switch to the Archived view to restore one.'
          }
        />
      )}

      {filtered.length > 0 && (
        <div className={styles.grid}>
          {filtered.map((p) => (
            <Card key={p.id} onClick={() => navigate(`/projects/${p.id}`)}>
              <div className={styles.projectHeader}>
                <p className={styles.projectName}>{p.name}</p>
                <button
                  className={styles.archiveBtn}
                  onClick={(e) => void handleArchive(e, p)}
                  title={p.archivedAt ? 'Restore project' : 'Archive project'}
                  aria-label={p.archivedAt ? 'Restore project' : 'Archive project'}
                >
                  {p.archivedAt ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 1 0 9-9" /><path d="M3 4v5h5" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="4" width="20" height="5" rx="1" /><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9" /><path d="M10 13h4" />
                    </svg>
                  )}
                </button>
              </div>
              <p className={styles.projectUrl}>{p.baseUrl}</p>
              {p.description && <p className={styles.projectDesc}>{p.description}</p>}
            </Card>
          ))}
        </div>
      )}
    </Shell>
  )
}
