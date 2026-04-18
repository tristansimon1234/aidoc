import { useEffect, useRef, useState, useCallback } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import { useImageLightbox } from './ImageLightbox.js'
import styles from './BlockEditor.module.css'

function findFirstTextNode(root: Node): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const node = walker.nextNode()
  return node instanceof Text ? node : null
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
    domAttributes: {
      editor: {
        class: styles.editor ?? '',
      },
    },
  })

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

  // Annotate quote blocks that follow the GitHub-style alert syntax
  // ([!NOTE] / [!TIP] / [!WARNING] / [!DANGER] / [!INFO]) with a
  // `data-callout-type` attribute so the CSS can render them as callouts.
  // Keeps markdown clean + round-trippable — the [!TYPE] stays in the text,
  // we just hide it visually via a `data-callout-marker` span.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const CALLOUT_RE = /^\[!(NOTE|INFO|TIP|WARNING|DANGER|CAUTION)\]\s*$/i

    const scan = (): void => {
      const quotes = el.querySelectorAll<HTMLElement>('[data-content-type="quote"]')
      quotes.forEach((q) => {
        const firstText = q.textContent?.split('\n')[0]?.trim() ?? ''
        const match = CALLOUT_RE.exec(firstText)
        if (match) {
          const type = match[1]!.toUpperCase()
          q.setAttribute('data-callout-type', type)
          // Wrap the `[!TYPE]` text so we can hide it via CSS without losing markdown
          const firstTextNode = findFirstTextNode(q)
          if (firstTextNode?.parentElement && !firstTextNode.parentElement.hasAttribute('data-callout-marker')) {
            const span = document.createElement('span')
            span.setAttribute('data-callout-marker', '')
            span.textContent = firstTextNode.nodeValue?.match(/\[![A-Z]+\]\s*/i)?.[0] ?? ''
            if (span.textContent) {
              const remaining = firstTextNode.nodeValue?.slice(span.textContent.length) ?? ''
              firstTextNode.nodeValue = remaining
              firstTextNode.parentElement.insertBefore(span, firstTextNode)
            }
          }
        } else {
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
      />
      {lightbox}
    </div>
  )
}
