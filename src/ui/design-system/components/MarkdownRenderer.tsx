import Markdown from 'react-markdown'
import styles from './MarkdownRenderer.module.css'

interface MarkdownRendererProps {
  content: string
}

export function MarkdownRenderer({ content }: MarkdownRendererProps): React.ReactElement {
  return (
    <div className={styles.article}>
      <Markdown>{content}</Markdown>
    </div>
  )
}
