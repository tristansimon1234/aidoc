import { useState } from 'react'
import styles from './CodeBlock.module.css'

interface CodeBlockProps {
  code: string
  language?: string
}

/** Dark code block matching the BlockEditor look (#161616 / #f5f5f5) with a
 *  floating Copy button in the top-right corner. The button stays hidden
 *  until hover on pointer devices and is always visible on touch screens.
 *  Used on public docs via MarkdownRenderer; mirrored in the BlockEditor
 *  via a MutationObserver that injects the same button into BlockNote's
 *  native code blocks so admin ↔ public stay identical. */
export function CodeBlock({ code, language }: CodeBlockProps): React.ReactElement {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={styles.wrapper} data-language={language ?? undefined}>
      <pre className={styles.pre}>
        <code>{code}</code>
      </pre>
      <button
        type="button"
        className={`${styles.copyBtn} ${copied ? styles.copied : ''}`}
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
      >
        {copied ? (
          <>
            <svg className={styles.copyIcon} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Copied
          </>
        ) : (
          <>
            <svg className={styles.copyIcon} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy
          </>
        )}
      </button>
    </div>
  )
}
