import { useOutletContext } from 'react-router-dom'
import { type ProjectDTO } from '../../../shared/api/client.js'
import { ChatPanel } from '../components/ChatPanel.js'
import styles from './ChatPage.module.css'

export function ChatPage(): React.ReactElement {
  const { project } = useOutletContext<{ project: ProjectDTO }>()

  return (
    <div className={styles.page}>
      <ChatPanel
        projectId={project.id}
        projectName={project.name}
        onClose={() => {}}
        inline
      />
    </div>
  )
}
