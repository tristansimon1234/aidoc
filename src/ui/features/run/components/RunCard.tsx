import { useNavigate } from 'react-router-dom'
import { Card, StatusIndicator } from '../../../design-system/components/index.js'
import type { RunDTO } from '../../../shared/api/client.js'
import styles from './RunCard.module.css'

interface RunCardProps {
  run: RunDTO
}

export function RunCard({ run }: RunCardProps): React.ReactElement {
  const navigate = useNavigate()

  return (
    <Card onClick={() => navigate(`/runs/${run.id}`)}>
      <div className={styles.row}>
        <div className={styles.info}>
          <p className={styles.name}>{run.featureName}</p>
          <p className={styles.url}>{run.startUrl}</p>
        </div>
        <div className={styles.meta}>
          {run.tokenUsage > 0 && (
            <span className={styles.tokens}>{run.tokenUsage.toLocaleString()} tok</span>
          )}
          <StatusIndicator status={run.status} />
        </div>
      </div>
    </Card>
  )
}
