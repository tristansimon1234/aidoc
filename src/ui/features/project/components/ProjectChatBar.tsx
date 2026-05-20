import { useState } from 'react'
import styles from './ProjectChatBar.module.css'

interface ProjectChatBarProps {
  onSubmit: (message: string) => void
  onFocus?: () => void
  projectName: string
}

const QUICK_PROMPTS = [
  'How do I generate documentation?',
  'What is Try Doc?',
  'How do I embed the chat widget?',
]

export function ProjectChatBar({ onSubmit, onFocus, projectName }: ProjectChatBarProps): React.ReactElement {
  const [value, setValue] = useState('')

  const submit = (): void => {
    const v = value.trim()
    if (!v) return
    setValue('')
    onSubmit(v)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') { e.preventDefault(); submit() }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.chips}>
        {QUICK_PROMPTS.map((p) => (
          <button
            key={p}
            className={styles.chip}
            onClick={() => onSubmit(p)}
            type="button"
          >
            {p}
          </button>
        ))}
      </div>
      <div className={styles.bar}>
        <svg className={styles.icon} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.34 6.34l-1.41-1.41M19.07 19.07l-1.41-1.41M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <input
          className={styles.input}
          type="text"
          placeholder={`Ask about ${projectName} or Doclee…`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={onFocus}
          onKeyDown={handleKey}
          aria-label="Ask the assistant"
        />
        <button
          className={styles.submit}
          onClick={submit}
          disabled={!value.trim()}
          type="button"
          aria-label="Send"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  )
}
