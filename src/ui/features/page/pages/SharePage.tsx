import { useOutletContext } from 'react-router-dom'
import { type ProjectDTO } from '../../../shared/api/client.js'
import { SharePanel } from '../components/SharePanel.js'
import styles from './SharePage.module.css'

export function SharePage(): React.ReactElement {
  const { project } = useOutletContext<{ project: ProjectDTO }>()

  return (
    <div className={styles.page}>
      <SharePanel project={project} onClose={() => {}} inline />
    </div>
  )
}
