import { useOutletContext } from 'react-router-dom'
import { ActivityFeed } from '../components/ActivityFeed.js'
import type { ProjectDTO, DocPageDTO } from '../../../shared/api/client.js'
import styles from './ProjectActivity.module.css'

interface ProjectOutletCtx {
  project: ProjectDTO
  pages: DocPageDTO[]
}

/**
 * Dedicated "Activity" tab — full-width rendering of the derived activity
 * feed (page edits, doc generations, new members). Lives under the project
 * nav alongside Pages / Chat / Share / Design / Analytics / Settings.
 */
export function ProjectActivity(): React.ReactElement {
  const { project } = useOutletContext<ProjectOutletCtx>()

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Activity</h1>
        <p className={styles.subtitle}>
          Recent edits, doc generations, and new members on {project.name}.
        </p>
      </header>
      <ActivityFeed projectId={project.id} />
    </div>
  )
}
