import { Link, useNavigate } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Card, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { useAsync } from '../../../shared/hooks/useAsync.js'
import { api } from '../../../shared/api/client.js'
import styles from './ProjectList.module.css'

interface ProjectListProps {
  onSignOut: () => Promise<void>
}

export function ProjectList({ onSignOut }: ProjectListProps): React.ReactElement {
  const navigate = useNavigate()
  const { data: projects, loading, error } = useAsync(() => api.projects.list())

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
        <EmptyState
          title="No projects yet"
          description="Create a project to start documenting your product."
          action={
            <Link to="/projects/new">
              <Button>Create Project</Button>
            </Link>
          }
        />
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
