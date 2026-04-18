import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core'
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems } from '@blocknote/react'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import { useImageLightbox } from './ImageLightbox.js'
import styles from './BlockEditor.module.css'

// Supported code-block languages. Without this the code block renders as a
// plain <pre>; with it BlockNote shows the language dropdown in the block's
// handle menu. No syntax highlighting yet — that would require shipping
// Shiki (~2 MB). Good enough for now, users can still pick their language.
const SUPPORTED_LANGUAGES = {
  text: { name: 'Plain text' },
  javascript: { name: 'JavaScript', aliases: ['js'] },
  typescript: { name: 'TypeScript', aliases: ['ts'] },
  tsx: { name: 'TSX' },
  jsx: { name: 'JSX' },
  python: { name: 'Python', aliases: ['py'] },
  bash: { name: 'Bash', aliases: ['sh', 'shell'] },
  json: { name: 'JSON' },
  yaml: { name: 'YAML', aliases: ['yml'] },
  html: { name: 'HTML' },
  css: { name: 'CSS' },
  sql: { name: 'SQL' },
  markdown: { name: 'Markdown', aliases: ['md'] },
  go: { name: 'Go' },
  rust: { name: 'Rust', aliases: ['rs'] },
} as const

type CalloutType = 'INFO' | 'TIP' | 'WARNING' | 'DANGER'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCalloutItems(editor: any): DefaultReactSuggestionItem[] {
  const insertCallout = (type: CalloutType): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insertOrUpdateBlockForSlashMenu(editor, {
      type: 'quote',
      content: [{ type: 'text', text: `[!${type}] `, styles: {} }],
    } as any)
  }
  return [
    {
      title: 'Info callout',
      subtext: 'Blue info box for general notes',
      group: 'Callouts',
      aliases: ['info', 'note', 'callout'],
      onItemClick: () => insertCallout('INFO'),
    },
    {
      title: 'Tip callout',
      subtext: 'Green tip box for helpful hints',
      group: 'Callouts',
      aliases: ['tip', 'hint', 'callout'],
      onItemClick: () => insertCallout('TIP'),
    },
    {
      title: 'Warning callout',
      subtext: 'Orange warning box for caveats',
      group: 'Callouts',
      aliases: ['warning', 'warn', 'callout'],
      onItemClick: () => insertCallout('WARNING'),
    },
    {
      title: 'Danger callout',
      subtext: 'Red danger box for destructive actions',
      group: 'Callouts',
      aliases: ['danger', 'caution', 'error', 'callout'],
      onItemClick: () => insertCallout('DANGER'),
    },
  ]
}

interface BlockEditorProps {
  content: string
  onSave: (markdown: string) => Promise<void>
  readOnly?: boolean
}

export function BlockEditor({ content, onSave, readOnly = false }: BlockEditorProps): React.ReactElement {
  const [saving, setSaving] = useState(false)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initializedRef = useRef(false)
  const lastContentRef = useRef('')
  const suppressNextChangeRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const { lightbox, openLightbox } = useImageLightbox()

  const getTheme = (): 'dark' | 'light' => {
    if (typeof document === 'undefined') return 'light'
    return (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') ?? 'light'
  }
  const [theme, setTheme] = useState<'dark' | 'light'>(getTheme)

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(getTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  const editor = useCreateBlockNote({
    codeBlock: {
      defaultLanguage: 'text',
      supportedLanguages: SUPPORTED_LANGUAGES,
    },
    domAttributes: {
      editor: {
        class: styles.editor ?? '',
      },
    },
  })

  // Slash menu: default items + our four callout entries, memo-stable per editor
  const getSlashItems = useMemo(
    () => async (query: string) =>
      filterSuggestionItems(
        [
          ...getDefaultReactSlashMenuItems(editor),
          ...getCalloutItems(editor),
        ],
        query,
      ),
    [editor],
  )

  // Parse markdown into blocks — on mount and when content changes
  useEffect(() => {
    if (!editor || !content) return

    // Skip if we already loaded this exact content
    if (initializedRef.current && content === lastContentRef.current) return

    initializedRef.current = true
    lastContentRef.current = content

    void (async () => {
      try {
        // Ensure images are on their own lines (BlockNote needs block-level images, not inline)
        const prepared = content
          .replace(/^(\s*\d+\.\s+.+)\n\s*(!\[.*?\]\(.*?\))\s*$/gm, '$1\n\n$2')
          .replace(/^(\s*[-*]\s+.+)\n\s*(!\[.*?\]\(.*?\))\s*$/gm, '$1\n\n$2')
          .replace(/(!\[.*?\]\(.*?\))(?=\S)/g, '$1\n')

        suppressNextChangeRef.current = true
        const blocks = await editor.tryParseMarkdownToBlocks(prepared)
        editor.replaceBlocks(editor.document, blocks)
      } catch {
        // markdown parsing failed
      }
    })()
  }, [editor, content])

  // Intercept clicks on images inside the editor to open lightbox
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (target.tagName === 'IMG') {
        const src = (target as HTMLImageElement).src
        if (src) {
          e.preventDefault()
          e.stopPropagation()
          openLightbox(src)
        }
      }
    }
    el.addEventListener('click', handler, true)
    return () => el.removeEventListener('click', handler, true)
  }, [openLightbox])

  // Annotate quote blocks that start with the GitHub-style alert marker
  // ([!NOTE] / [!TIP] / [!WARNING] / [!DANGER] / [!INFO]) with a
  // `data-callout-type` attribute so the CSS can render them as callouts.
  //
  // We ONLY toggle an attribute — never mutate the DOM itself. Rewriting the
  // text nodes fights ProseMirror's reconciliation and crashes the editor.
  // The `[!TYPE]` marker stays visible as the user's markdown source, which
  // is fine in edit mode; the read-only `MarkdownRenderer` hides it.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const CALLOUT_RE = /^\s*\[!(NOTE|INFO|TIP|WARNING|DANGER|CAUTION)\]/i

    const scan = (): void => {
      const quotes = el.querySelectorAll<HTMLElement>('[data-content-type="quote"]')
      quotes.forEach((q) => {
        const firstText = q.textContent?.split('\n')[0] ?? ''
        const match = CALLOUT_RE.exec(firstText)
        if (match) {
          q.setAttribute('data-callout-type', match[1]!.toUpperCase())
        } else if (q.hasAttribute('data-callout-type')) {
          q.removeAttribute('data-callout-type')
        }
      })
    }

    scan()
    const observer = new MutationObserver(scan)
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [])

  const handleChange = useCallback(() => {
    if (readOnly) return

    // Skip save when content was loaded programmatically (not user edit)
    if (suppressNextChangeRef.current) {
      suppressNextChangeRef.current = false
      return
    }

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = setTimeout(() => {
      void (async () => {
        try {
          setSaving(true)
          const markdown = await editor.blocksToMarkdownLossy(editor.document)
          lastContentRef.current = markdown
          await onSave(markdown)
        } catch {
          // save failed
        } finally {
          setSaving(false)
        }
      })()
    }, 2000)
  }, [editor, onSave, readOnly])

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    }
  }, [])

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {saving && <span className={styles.saving}>Saving...</span>}
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        onChange={handleChange}
        theme={theme}
        slashMenu={false}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={getSlashItems}
        />
      </BlockNoteView>
      {lightbox}
    </div>
  )
}
