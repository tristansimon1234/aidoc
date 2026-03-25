import { useParams, Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Badge, Spinner, StatusIndicator, CodeBlock, EmptyState } from '../../../design-system/components/index.js'
import { useAsync } from '../../../shared/hooks/useAsync.js'
import { api } from '../../../shared/api/client.js'
import { StepTimeline } from '../components/StepTimeline.js'
import styles from './RunDetail.module.css'

export function RunDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>()

  const { data: run, loading: runLoading } = useAsync(() => api.runs.get(id!), [id])
  const { data: steps, loading: stepsLoading } = useAsync(() => api.runs.steps(id!), [id])
  const { data: doc } = useAsync(
    () => api.runs.doc(id!).catch(() => null),
    [id],
  )

  if (runLoading) {
    return (
      <Shell>
        <Spinner size="lg" />
      </Shell>
    )
  }

  if (!run) {
    return (
      <Shell>
        <EmptyState title="Run not found" />
      </Shell>
    )
  }

  return (
    <Shell>
      <Link to="/" className={styles.back}>
        &larr; runs
      </Link>

      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{run.featureName}</h1>
          <StatusIndicator status={run.status} />
        </div>
        <p className={styles.goal}>{run.goal}</p>
        <div className={styles.badges}>
          <Badge color="blue">{run.tokenUsage.toLocaleString()} tokens</Badge>
          <Badge color="purple">{steps?.length ?? 0} steps</Badge>
        </div>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Steps</h2>
        {stepsLoading && <Spinner />}
        {steps && steps.length === 0 && <EmptyState title="No steps recorded" />}
        {steps && steps.length > 0 && <StepTimeline steps={steps} />}
      </section>

      {doc?.markdownContent && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Generated Documentation</h2>
          <CodeBlock code={doc.markdownContent} language="markdown" />
        </section>
      )}
    </Shell>
  )
}
