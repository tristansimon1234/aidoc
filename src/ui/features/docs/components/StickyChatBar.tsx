import { useState } from 'react'
import styles from './StickyChatBar.module.css'

interface StickyChatBarProps {
  /** Called when the user submits a question. Receives the message and
   *  expects the parent to open the panel + forward it as a pending
   *  message. */
  onSubmit: (message: string) => void
  /** Called when the user clicks/focuses the input without typing. Lets
   *  the parent open the panel immediately so the focus moves into the
   *  panel's own textarea. */
  onFocus?: () => void
  placeholder?: string
}

/**
 * Sticky chat input at the bottom of the public docs content. Lives
 * inside the scroll container with `position: sticky; bottom: 0`, so it
 * rides along with the content but stays pinned while there's still
 * material below. Visually styled as a floating pill — gradient mask
 * above it hides the content behind.
 */
export function StickyChatBar({ onSubmit, onFocus, placeholder = 'Poser une question…' }: StickyChatBarProps): React.ReactElement {
  const [value, setValue] = useState('')

  const submit = (): void => {
    const v = value.trim()
    if (!v) return
    setValue('')
    onSubmit(v)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <svg className={styles.icon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9.5 3a6.5 6.5 0 1 0 4.61 11.09l4.4 4.4a1 1 0 0 0 1.41-1.41l-4.4-4.4A6.5 6.5 0 0 0 9.5 3Z" />
        </svg>
        <input
          className={styles.input}
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={onFocus}
          onKeyDown={handleKey}
          aria-label="Poser une question à l'assistant"
        />
        <button
          className={styles.submit}
          onClick={submit}
          disabled={!value.trim()}
          aria-label="Envoyer"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  )
}
