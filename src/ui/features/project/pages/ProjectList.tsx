import { Link, useNavigate } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Card, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { useAsync } from '../../../shared/hooks/useAsync.js'
import { fetchProjects } from '../../../shared/api/db.js'
import styles from './ProjectList.module.css'

interface ProjectListProps {
  onSignOut: () => Promise<void>
}

export function ProjectList({ onSignOut }: ProjectListProps): React.ReactElement {
  const navigate = useNavigate()
  const { data: projects, loading, error } = useAsync(() => fetchProjects())

  return (
    <Shell
      actions={
        <>
          <Link to="/projects/new">
            <Button size="sm">New Project</Button>
          </Link>
          <Button size="sm" variant="ghost" onClick={() => void onSignOut()}>
            Sign Out
          </Button>
        </>
      }
    >
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Projects</h1>
          {projects && <p className={styles.subtitle}>{projects.length} project{projects.length !== 1 ? 's' : ''}</p>}
        </div>
      </div>

      {loading && <Spinner />}
      {error && <EmptyState title="Failed to load" description={error} />}

      {projects && projects.length === 0 && (
        <div style={{ maxWidth: '500px', margin: '0 auto', textAlign: 'center', padding: 'var(--space-2xl) 0' }}>
          <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 'var(--space-sm)' }}>
            Welcome to aidoc
          </h2>
          <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--space-xl)' }}>
            Create beautiful product documentation in minutes, not hours.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', textAlign: 'left', marginBottom: 'var(--space-xl)' }}>
            {[
              { step: '1', title: 'Create a project', desc: 'Add your product URL and describe what it does' },
              { step: '2', title: 'AI scans your site', desc: 'Our agent explores your app and proposes a doc structure' },
              { step: '3', title: 'Review & publish', desc: 'Edit the generated docs, add details, and organize pages' },
            ].map((s) => (
              <div key={s.step} style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'flex-start' }}>
                <span style={{
                  width: '28px', height: '28px', borderRadius: 'var(--radius-full)',
                  backgroundColor: 'var(--color-accent-blue)', color: 'var(--color-text-inverse)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 'var(--text-sm)', fontWeight: 600, flexShrink: 0,
                }}>
                  {s.step}
                </span>
                <div>
                  <p style={{ fontWeight: 500, margin: 0, fontSize: 'var(--text-base)' }}>{s.title}</p>
                  <p style={{ color: 'var(--color-text-muted)', margin: '2px 0 0', fontSize: 'var(--text-sm)' }}>{s.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <Link to="/projects/new">
            <Button>Create Your First Project</Button>
          </Link>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className={styles.grid}>
          {projects.map((p) => (
            <Card key={p.id} onClick={() => navigate(`/projects/${p.id}`)}>
              <p className={styles.projectName}>{p.name}</p>
              <p className={styles.projectUrl}>{p.baseUrl}</p>
              {p.description && <p className={styles.projectDesc}>{p.description}</p>}
            </Card>
          ))}
        </div>
      )}
    </Shell>
  )
}
