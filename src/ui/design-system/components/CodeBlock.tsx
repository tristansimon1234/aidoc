import styles from './CodeBlock.module.css'

interface CodeBlockProps {
  code: string
  language?: string
}

export function CodeBlock({ code, language }: CodeBlockProps): React.ReactElement {
  return (
    <div className={styles.wrapper}>
      {language && <div className={styles.lang}>{language}</div>}
      <pre className={styles.pre}>
        <code>{code}</code>
      </pre>
    </div>
  )
}
