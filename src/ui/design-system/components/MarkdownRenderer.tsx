import Markdown from 'react-markdown'
import type { ProjectDesignDTO } from '../../shared/api/client.js'
import styles from './MarkdownRenderer.module.css'

interface MarkdownRendererProps {
  content: string
  design?: ProjectDesignDTO | null
}

export function MarkdownRenderer({ content, design }: MarkdownRendererProps): React.ReactElement {
  const style: React.CSSProperties | undefined = design ? {
    '--doc-accent': design.accentColor,
    '--doc-bg': design.bgColor,
    '--doc-text': design.textColor,
    '--doc-font': design.font,
  } as React.CSSProperties : undefined

  return (
    <div className={`${styles.article} ${design ? styles.themed : ''}`} style={style}>
      <Markdown>{content}</Markdown>
    </div>
  )
}
