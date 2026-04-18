import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { BlockNoteSchema, defaultBlockSpecs, filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core'
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems } from '@blocknote/react'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import { useImageLightbox } from './ImageLightbox.js'
import { Callout, type CalloutType } from './CalloutBlock.js'
import styles from './BlockEditor.module.css'

const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    callout: Callout(),
  },
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = any

function getCalloutItems(editor: Editor): DefaultReactSuggestionItem[] {
  const insert = (type: CalloutType) => () => {
    insertOrUpdateBlockForSlashMenu(editor, {
      type: 'callout',
      props: { calloutType: type },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }
  return [
    { title: 'Info callout', subtext: 'Blue info box', group: 'Callouts', aliases: ['info', 'note', 'callout'], onItemClick: insert('info') },
    { title: 'Tip callout', subtext: 'Green tip box', group: 'Callouts', aliases: ['tip', 'hint', 'callout'], onItemClick: insert('tip') },
    { title: 'Warning callout', subtext: 'Orange warning box', group: 'Callouts', aliases: ['warning', 'warn', 'callout'], onItemClick: insert('warning') },
    { title: 'Danger callout', subtext: 'Red danger box', group: 'Callouts', aliases: ['danger', 'caution', 'error', 'callout'], onItemClick: insert('danger') },
  ]
}

// Flatten list-item continuation paragraphs so they don't collide with
// BlockNote's indented-code-block rule. Given:
//
//   3.  **Title**
//       First paragraph of the item.
//
//       ![Image](url)
//
//       Second paragraph.
//
// we emit:
//
//   3. **Title** First paragraph of the item.
//
//   ![Image](url)
//
//   Second paragraph.
//
// Nested bullets stay indented (BlockNote handles those fine), and fenced
// code blocks are passed through untouched.
function normalizeListContinuation(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let inFenced = false
  let i = 0

  const isIndented = (s: string): boolean => /^ {4,}\S/.test(s)
  const isIndentedBullet = (s: string): boolean => /^ {4,}(?:[*\-+]|\d+\.)\s/.test(s)

  while (i < lines.length) {
    const line = lines[i]!

    if (/^\s*```/.test(line)) {
      inFenced = !inFenced
      out.push(line)
      i++
      continue
    }
    if (inFenced) {
      out.push(line)
      i++
      continue
    }

    const listMatch = /^(\s*)(\d+\.)\s+(.*)$/.exec(line)
    if (listMatch) {
      const prefix = listMatch[1] ?? ''
      const marker = listMatch[2]!
      const rest = listMatch[3]!
      const next = lines[i + 1]
      // If the very next line is indented non-bullet continuation, merge it
      // into the list item so the marker isn't left alone with the image.
      if (next !== undefined && isIndented(next) && !isIndentedBullet(next)) {
        out.push(`${prefix}${marker} ${rest} ${next.trimStart()}`)
        i += 2
        continue
      }
      out.push(`${prefix}${marker} ${rest}`)
      i++
      continue
    }

    // Dedent indented continuation paragraphs/images to root level. Keep
    // sub-bullets indented — BlockNote handles nested lists correctly.
    if (line.startsWith('    ') && !isIndentedBullet(line)) {
      out.push(line.slice(4))
      i++
      continue
    }

    out.push(line)
    i++
  }

  return out.join('\n')
}

// After parsing markdown, BlockNote returns plain `quote` blocks even for our
// GFM-alert syntax (`> [!TIP]\n> content`). Walk the tree and promote those
// to `callout` blocks so reload preserves the styling round-trip.
const ALERT_RE = /^\s*\[!(INFO|NOTE|TIP|WARNING|DANGER|CAUTION)\]\s*\n?/i

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function promoteCallouts(blocks: any[]): any[] {
  return blocks.map((b) => {
    const withChildren = b.children && Array.isArray(b.children) && b.children.length > 0
      ? { ...b, children: promoteCallouts(b.children) }
      : b
    if (withChildren.type !== 'quote' || !Array.isArray(withChildren.content)) return withChildren
    // Only support inline content arrays here (BlockNote's default for quotes)
    const first = withChildren.content[0]
    if (!first || first.type !== 'text' || typeof first.text !== 'string') return withChildren
    const match = ALERT_RE.exec(first.text)
    if (!match) return withChildren
    const raw = match[1]!.toUpperCase()
    const calloutType: CalloutType =
      raw === 'NOTE' ? 'info' :
      raw === 'CAUTION' ? 'danger' :
      raw === 'INFO' ? 'info' :
      raw === 'TIP' ? 'tip' :
      raw === 'WARNING' ? 'warning' :
      'danger'
    const stripped = first.text.slice(match[0].length)
    const newContent = stripped.length > 0
      ? [{ ...first, text: stripped }, ...withChildren.content.slice(1)]
      : withChildren.content.slice(1)
    return {
      ...withChildren,
      type: 'callout',
      props: { ...withChildren.props, calloutType },
      content: newContent,
    }
  })
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
    schema,
    domAttributes: {
      editor: {
        class: styles.editor ?? '',
      },
    },
  })

  const getSlashItems = useMemo(
    () => async (query: string) =>
      filterSuggestionItems(
        [...getDefaultReactSlashMenuItems(editor), ...getCalloutItems(editor)],
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
        // BlockNote's markdown parser (per the official docs) is explicitly
        // lossy: a paragraph/image indented 4 spaces under a numbered list
        // item gets treated as an indented code block, not as list-item
        // continuation. Flatten those into root-level blocks so the image
        // and following text round-trip as real image + paragraph blocks.
        const prepared = normalizeListContinuation(content)
          .replace(/^(\s*\d+\.\s+.+)\n\s*(!\[.*?\]\(.*?\))\s*$/gm, '$1\n\n$2')
          .replace(/^(\s*[-*]\s+.+)\n\s*(!\[.*?\]\(.*?\))\s*$/gm, '$1\n\n$2')
          .replace(/(!\[.*?\]\(.*?\))(?=\S)/g, '$1\n')

        suppressNextChangeRef.current = true
        const blocks = await editor.tryParseMarkdownToBlocks(prepared)
        const promoted = promoteCallouts(blocks)
        editor.replaceBlocks(editor.document, promoted)
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
        <SuggestionMenuController triggerCharacter="/" getItems={getSlashItems} />
      </BlockNoteView>
      {lightbox}
    </div>
  )
}
