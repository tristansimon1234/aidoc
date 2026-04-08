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
          {projects && projects.length > 0 && (
            <p className={styles.subtitle}>{projects.length} project{projects.length !== 1 ? 's' : ''}</p>
          )}
        </div>
      </div>

      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-2xl)' }}><Spinner size="lg" /></div>}
      {error && <EmptyState title="Failed to load" description={error} />}

      {projects && projects.length === 0 && (
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
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                </div>
                <div>
                  <p className={styles.featureTitle}>AI Documentation</p>
                  <p className={styles.featureDesc}>Upload a video, get a full product guide with screenshots</p>
                </div>
              </div>
              <div className={styles.feature}>
                <div className={styles.featureIcon} style={{ color: 'var(--color-primary)' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </div>
                <div>
                  <p className={styles.featureTitle}>Embeddable Chat Widget</p>
                  <p className={styles.featureDesc}>Your users ask questions, AI answers from your docs</p>
                </div>
              </div>
              <div className={styles.feature}>
                <div className={styles.featureIcon} style={{ color: 'var(--color-warning)' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
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
