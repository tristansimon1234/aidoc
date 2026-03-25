import { Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { useAsync } from '../../../shared/hooks/useAsync.js'
import { api } from '../../../shared/api/client.js'
import { RunCard } from '../components/RunCard.js'
import styles from './RunDashboard.module.css'

interface RunDashboardProps {
  onSignOut: () => Promise<void>
}

export function RunDashboard({ onSignOut }: RunDashboardProps): React.ReactElement {
  const { data: runs, loading, error } = useAsync(() => api.runs.list())

  return (
    <Shell
      actions={
        <>
          <Link to="/runs/new">
            <Button size="sm">New Run</Button>
          </Link>
          <Button size="sm" variant="ghost" onClick={() => void onSignOut()}>
            Sign Out
          </Button>
        </>
      }
    >
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Runs</h1>
          {runs && <p className={styles.subtitle}>{runs.length} total</p>}
        </div>
      </div>

      {loading && <Spinner />}
      {error && <EmptyState title="Failed to load" description={error} />}

      {runs && runs.length === 0 && (
        <EmptyState
          title="No runs yet"
          description="Start your first documentation run to explore a feature."
          action={
            <Link to="/runs/new">
              <Button>Create a run</Button>
            </Link>
          }
        />
      )}

      {runs && runs.length > 0 && (
        <div className={styles.list}>
          {runs.map((run) => (
            <RunCard key={run.id} run={run} />
          ))}
        </div>
      )}
    </Shell>
  )
}
