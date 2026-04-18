import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { BlockNoteSchema, defaultBlockSpecs, filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core'
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems } from '@blocknote/react'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import { marked } from 'marked'
import { useImageLightbox } from './ImageLightbox.js'
import { Callout, type CalloutType } from './CalloutBlock.js'
import styles from './BlockEditor.module.css'

// BlockNote's markdown importer (tryParseMarkdownToBlocks) is documented as
// lossy: it drops images between numbered list items, mis-handles 4-space
// indented continuation content, and generally struggles with non-trivial
// markdown. Per the official BlockNote docs, HTML is the recommended
// intermediate for robust imports. We run `marked` (battle-tested CommonMark/
// GFM parser) to produce HTML, then let BlockNote consume that via
// tryParseHTMLToBlocks — which preserves the DOM structure unambiguously.
marked.setOptions({ gfm: true, breaks: false })

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

// Markdown → HTML → blocks, with a safety fallback on the legacy markdown
// parser if HTML import ever throws. Kept module-level so the load effect
// reads linearly; any failure is logged so silent blank editors don't
// happen unnoticed.
async function loadFromMarkdown(editor: Editor, markdown: string): Promise<void> {
  try {
    const html = await marked.parse(markdown)
    const blocks = await editor.tryParseHTMLToBlocks(html)
    editor.replaceBlocks(editor.document, promoteCallouts(blocks))
  } catch (err) {
    console.warn('[BlockEditor] HTML-first import failed, falling back to markdown parser', err)
    try {
      const blocks = await editor.tryParseMarkdownToBlocks(markdown)
      editor.replaceBlocks(editor.document, promoteCallouts(blocks))
    } catch (fallbackErr) {
      console.error('[BlockEditor] both HTML and markdown parsers failed', fallbackErr)
    }
  }
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

  // Load the document. Prefer contentBlocks (lossless BlockNote JSON) when
  // present; fall back to the markdown projection for legacy pages and for
  // pages just regenerated by the AI (auto-copy from generated_docs clears
  // content_blocks so the fresh markdown gets re-imported here).
  useEffect(() => {
    if (!editor) return
    // Cache key captures both shapes so changing either triggers a reload.
    const key = contentBlocks ? `blocks:${JSON.stringify(contentBlocks)}` : `md:${content}`
    if (key === 'md:') return
    if (initializedRef.current && key === lastContentRef.current) return
    initializedRef.current = true
    lastContentRef.current = key

    // Reset the user-interaction gate so load-time onChange events are ignored
    // until the user actually types/pastes/etc.
    userInteractedRef.current = false

    void (async () => {
      if (contentBlocks && Array.isArray(contentBlocks) && contentBlocks.length > 0) {
        // Lossless path: hydrate the JSON directly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.replaceBlocks(editor.document, contentBlocks as any[])
        return
      }
      if (!content) return
      await loadFromMarkdown(editor, content)
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
