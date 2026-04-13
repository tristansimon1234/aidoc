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
