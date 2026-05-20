import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import styles from './ProjectChatBar.module.css'

interface ProjectChatBarProps {
  onSubmit: (message: string) => void
  onVideoDrop?: (file: File) => void
  projectName: string
}

interface QuickPrompt {
  label: string
  prompt: string
}

const QUICK_PROMPTS: QuickPrompt[] = [
  { label: 'Generate from video', prompt: 'I want to generate documentation from a screen recording' },
  { label: 'Create a page', prompt: 'Create a new documentation page' },
  { label: 'Search docs', prompt: 'Search the documentation for ' },
  { label: 'Run a Try Doc test', prompt: 'Run a Try Doc test on the latest page' },
]

interface SlashCommand {
  trigger: string
  label: string
  description: string
  prompt: string
}

const SLASH_COMMANDS: SlashCommand[] = [
  { trigger: '/generate', label: 'Generate from video', description: 'Open the upload block for AI-generated docs', prompt: 'Generate documentation from a video' },
  { trigger: '/page', label: 'New page', description: 'Create a new documentation page', prompt: 'Create a new documentation page called ' },
  { trigger: '/list', label: 'List pages', description: 'Show all pages in this project', prompt: 'List all the pages in this project' },
  { trigger: '/search', label: 'Search docs', description: 'Semantic search across the docs', prompt: 'Search the documentation for ' },
  { trigger: '/test', label: 'Run Try Doc', description: 'AI tests your doc on the live product', prompt: 'Run a Try Doc test on ' },
  { trigger: '/voice', label: 'Generate voice-over', description: 'Add ElevenLabs narration to a page', prompt: 'Generate a voice-over for ' },
  { trigger: '/publish', label: 'Publish a page', description: 'Toggle public visibility', prompt: 'Publish the page ' },
  { trigger: '/help', label: 'Help', description: 'Learn what the assistant can do', prompt: 'What can you do? Show me everything I can ask.' },
]

const ROTATING_PLACEHOLDERS = [
  'Ask anything, or drop a video to generate docs…',
  'Try: "Document the checkout flow from a video"',
  'Try: "Create a page about onboarding"',
  'Try: "/" for commands',
]

const COACHMARK_KEY = 'aidoc_chatbar_coachmark_seen'

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
  const [slashIdx, setSlashIdx] = useState(0)
  const [showCoachmark, setShowCoachmark] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Compute the slash menu state from the current input
  const slashState = useMemo(() => {
    if (!value.startsWith('/')) return { open: false, items: [] as SlashCommand[] }
    const lowered = value.toLowerCase()
    const matches = SLASH_COMMANDS.filter((c) => c.trigger.startsWith(lowered) || lowered.startsWith(c.trigger))
    return { open: matches.length > 0, items: matches.slice(0, 6) }
  }, [value])

  // Reset slash menu cursor when the menu items change
  useEffect(() => {
    setSlashIdx(0)
  }, [slashState.items.length])

  // Rotate placeholder every 5s, paused when typing/focused
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.activeElement === inputRef.current) return
      if (value.length > 0) return
      setPlaceholderIdx((i) => (i + 1) % ROTATING_PLACEHOLDERS.length)
    }, 5000)
    return () => clearInterval(interval)
  }, [value])

  // Global Cmd/Ctrl+K focuses the bar
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

  // First-visit coachmark
  useEffect(() => {
    if (typeof window === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      if (!localStorage.getItem(COACHMARK_KEY)) {
        timer = setTimeout(() => setShowCoachmark(true), 1200)
      }
    } catch { /* ignore privacy mode */ }
    return () => { if (timer) clearTimeout(timer) }
  }, [])

  const dismissCoachmark = useCallback((): void => {
    setShowCoachmark(false)
    try { localStorage.setItem(COACHMARK_KEY, '1') } catch { /* ignore */ }
  }, [])

  const submit = (text?: string): void => {
    const v = (text ?? value).trim()
    if (!v) return
    setValue('')
    dismissCoachmark()
    onSubmit(v)
  }

  const pickSlashCommand = (cmd: SlashCommand): void => {
    setValue(cmd.prompt)
    inputRef.current?.focus()
    // If the prompt ends with " " it's a fill-in template, otherwise auto-submit.
    if (!cmd.prompt.endsWith(' ')) {
      submit(cmd.prompt)
    }
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (slashState.open && slashState.items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIdx((i) => (i + 1) % slashState.items.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIdx((i) => (i - 1 + slashState.items.length) % slashState.items.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const cmd = slashState.items[slashIdx]
        if (cmd) pickSlashCommand(cmd)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setValue('')
        return
      }
    }
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
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent): void => {
    if (!onVideoDrop) return
    e.preventDefault()
    setDragOver(false)
    dismissCoachmark()
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('video/'))
    if (file) onVideoDrop(file)
  }, [onVideoDrop, dismissCoachmark])

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

      {showCoachmark && (
        <div className={styles.coachmark} role="status">
          <div className={styles.coachmarkInner}>
            <div className={styles.coachmarkTitle}>
              <span className={styles.coachmarkSparkle} aria-hidden="true">✨</span>
              Doclee is chat-first
            </div>
            <p className={styles.coachmarkBody}>
              Ask anything, drop a video, or press <kbd>{SHORTCUT_LABEL}</kbd> from anywhere. Type <kbd>/</kbd> to see all commands.
            </p>
            <button type="button" className={styles.coachmarkDismiss} onClick={dismissCoachmark}>
              Got it
            </button>
          </div>
          <div className={styles.coachmarkArrow} aria-hidden="true" />
        </div>
      )}

      {/* Slash command menu — opens above the input when "/" is typed */}
      {slashState.open && (
        <div className={styles.slashMenu} role="listbox">
          {slashState.items.map((cmd, idx) => (
            <button
              key={cmd.trigger}
              type="button"
              role="option"
              aria-selected={idx === slashIdx}
              className={`${styles.slashItem} ${idx === slashIdx ? styles.slashItemActive : ''}`}
              onMouseEnter={() => setSlashIdx(idx)}
              onClick={() => pickSlashCommand(cmd)}
            >
              <span className={styles.slashTrigger}>{cmd.trigger}</span>
              <span className={styles.slashLabel}>{cmd.label}</span>
              <span className={styles.slashDesc}>{cmd.description}</span>
            </button>
          ))}
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
          onFocus={dismissCoachmark}
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
