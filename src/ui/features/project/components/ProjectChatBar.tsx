import { useState, useEffect, useRef, useCallback } from 'react'
import styles from './ProjectChatBar.module.css'

interface ProjectChatBarProps {
  onSubmit: (message: string) => void
  onVideoDrop?: (file: File) => void
  projectName: string
}

const QUICK_PROMPTS = [
  { label: 'Generate from video', prompt: 'I want to generate documentation from a screen recording' },
  { label: 'Create a page', prompt: 'Create a new documentation page' },
  { label: 'Search docs', prompt: 'Search the documentation for ' },
  { label: 'Run a Try Doc test', prompt: 'Run a Try Doc test on the latest page' },
]

const ROTATING_PLACEHOLDERS = [
  'Ask anything, or drop a video to generate docs…',
  'Try: "Document the checkout flow from a video"',
  'Try: "Create a page about onboarding"',
  'Try: "What is the Try Doc feature?"',
]

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const SHORTCUT_LABEL = isMac ? '⌘K' : 'Ctrl K'

export function ProjectChatBar({
  onSubmit,
  onVideoDrop,
  projectName,
}: ProjectChatBarProps): React.ReactElement {
  const [value, setValue] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [placeholderIdx, setPlaceholderIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Rotate placeholder every 5s, but pause when the user is typing/focused.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.activeElement === inputRef.current) return
      if (value.length > 0) return
      setPlaceholderIdx((i) => (i + 1) % ROTATING_PLACEHOLDERS.length)
    }, 5000)
    return () => clearInterval(interval)
  }, [value])

  // Global keyboard shortcut: Cmd/Ctrl+K focuses the bar.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const submit = (text?: string): void => {
    const v = (text ?? value).trim()
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

  // Video drag-and-drop on the entire bar
  const handleDragOver = useCallback((e: React.DragEvent): void => {
    if (!onVideoDrop) return
    const items = Array.from(e.dataTransfer.items ?? [])
    const hasVideo = items.some((it) => it.kind === 'file' && it.type.startsWith('video/'))
    if (!hasVideo) return
    e.preventDefault()
    setDragOver(true)
  }, [onVideoDrop])

  const handleDragLeave = useCallback((e: React.DragEvent): void => {
    // Only end dragOver when the drag actually leaves the container,
    // not when it crosses an inner child element.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent): void => {
    if (!onVideoDrop) return
    e.preventDefault()
    setDragOver(false)
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('video/'))
    if (file) onVideoDrop(file)
  }, [onVideoDrop])

  return (
    <div
      className={`${styles.wrap} ${dragOver ? styles.wrapDrag : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className={styles.dropOverlay} aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
          <span>Drop the video — Doclee will generate the docs</span>
        </div>
      )}

      {/* Quick-action chips */}
      <div className={styles.chips}>
        <span className={styles.chipsLabel}>Quick actions:</span>
        {QUICK_PROMPTS.map((q) => (
          <button
            key={q.label}
            className={styles.chip}
            onClick={() => submit(q.prompt)}
            type="button"
          >
            {q.label}
          </button>
        ))}
      </div>

      {/* Main pill */}
      <div className={styles.bar}>
        <span className={styles.aiIcon} aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
            <path d="M12 3a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
          </svg>
        </span>
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          placeholder={value ? '' : `Ask anything about ${projectName} — ${ROTATING_PLACEHOLDERS[placeholderIdx]}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKey}
          aria-label="Ask the assistant"
        />
        <kbd className={styles.kbd} aria-hidden="true">{SHORTCUT_LABEL}</kbd>
        <button
          className={styles.submit}
          onClick={() => submit()}
          disabled={!value.trim()}
          type="button"
          aria-label="Send"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  )
}
