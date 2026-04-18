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
  /** Markdown projection — used when `contentBlocks` is null (legacy or
   *  freshly-generated pages). */
  content: string
  /** BlockNote document JSON — lossless source of truth when present. */
  contentBlocks?: unknown
  /** Called on every real user edit with both the JSON (lossless) and the
   *  markdown projection (for public-docs rendering + RAG indexing). */
  onSave: (markdown: string, blocks: unknown) => Promise<void>
  readOnly?: boolean
}

export function BlockEditor({ content, contentBlocks, onSave, readOnly = false }: BlockEditorProps): React.ReactElement {
  const [saving, setSaving] = useState(false)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initializedRef = useRef(false)
  const lastContentRef = useRef('')
  // Only save after the user has actually interacted with the editor. Without
  // this gate, BlockNote's replaceBlocks + its async normalization fire
  // multiple onChange events during the initial load, each of which would
  // otherwise persist a lossy markdown round-trip of the just-loaded content
  // (e.g. images between numbered list items vanish).
  const userInteractedRef = useRef(false)
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

  // Load the document. Prefer contentBlocks (lossless JSON) when present;
  // fall back to parsing the markdown projection for legacy pages and for
  // pages whose content has just been regenerated by the AI (auto-copy from
  // generated_docs clears content_blocks on purpose).
  useEffect(() => {
    if (!editor) return
    // Use a cache key that captures both shapes; changing either triggers a reload.
    const key = contentBlocks ? `blocks:${JSON.stringify(contentBlocks)}` : `md:${content}`
    if (!key || key === 'md:') return

    if (initializedRef.current && key === lastContentRef.current) return

    initializedRef.current = true
    lastContentRef.current = key

    // Reset the user-interaction gate so load-time onChange events are ignored
    // until the user actually types/pastes/etc.
    userInteractedRef.current = false

    void (async () => {
      try {
        if (contentBlocks && Array.isArray(contentBlocks) && contentBlocks.length > 0) {
          // Lossless path: just hydrate the JSON into the editor.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          editor.replaceBlocks(editor.document, contentBlocks as any[])
          return
        }
        if (!content) return

        // Fallback: parse markdown. BlockNote's markdown parser (per the
        // official docs) is explicitly lossy: a paragraph/image indented
        // 4 spaces under a numbered list item gets treated as an indented
        // code block, not as list-item continuation. Flatten those into
        // root-level blocks so the image and following text round-trip as
        // real image + paragraph blocks.
        const prepared = normalizeListContinuation(content)
          .replace(/^(\s*\d+\.\s+.+)\n\s*(!\[.*?\]\(.*?\))\s*$/gm, '$1\n\n$2')
          .replace(/^(\s*[-*]\s+.+)\n\s*(!\[.*?\]\(.*?\))\s*$/gm, '$1\n\n$2')
          .replace(/(!\[.*?\]\(.*?\))(?=\S)/g, '$1\n')

        const blocks = await editor.tryParseMarkdownToBlocks(prepared)
        const promoted = promoteCallouts(blocks)
        editor.replaceBlocks(editor.document, promoted)
      } catch {
        // load failed
      }
    })()
  }, [editor, content, contentBlocks])

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

  // Flip the user-interaction gate on real input events so subsequent
  // onChange events are allowed to persist. Captured at the container so
  // we see events from anywhere in BlockNote's DOM.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const mark = (): void => { userInteractedRef.current = true }
    el.addEventListener('keydown', mark, true)
    el.addEventListener('paste', mark, true)
    el.addEventListener('cut', mark, true)
    el.addEventListener('drop', mark, true)
    el.addEventListener('beforeinput', mark, true)
    return () => {
      el.removeEventListener('keydown', mark, true)
      el.removeEventListener('paste', mark, true)
      el.removeEventListener('cut', mark, true)
      el.removeEventListener('drop', mark, true)
      el.removeEventListener('beforeinput', mark, true)
    }
  }, [])

  const handleChange = useCallback(() => {
    if (readOnly) return

    // Only persist real user edits. Without this gate, replaceBlocks and
    // BlockNote's async normalization fire onChange events that would
    // overwrite page.content with a lossy markdown round-trip of what
    // was just loaded (e.g. images inside numbered lists get dropped
    // because tryParseMarkdownToBlocks / blocksToMarkdownLossy don't
    // round-trip them cleanly).
    if (!userInteractedRef.current) return

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = setTimeout(() => {
      void (async () => {
        try {
          setSaving(true)
          const blocks = editor.document
          const markdown = await editor.blocksToMarkdownLossy(blocks)
          // Keep the load cache key in sync so the useEffect doesn't
          // re-hydrate the editor from our own save.
          lastContentRef.current = `blocks:${JSON.stringify(blocks)}`
          await onSave(markdown, blocks)
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
