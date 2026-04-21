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

/** Minimal structural contract for a BlockNote document block. BlockNote's
 *  own `Block` type is generic over the schema and effectively `any` through
 *  our `Editor` alias; this guard is the defensive line before we hand raw
 *  JSONB from the DB to `replaceBlocks`. */
type BlockLike = { type: string; [k: string]: unknown }

function isBlockLike(value: unknown): value is BlockLike {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

function asBlockArray(value: unknown): BlockLike[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  if (!value.every(isBlockLike)) return null
  return value as BlockLike[]
}

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
  // True while the editor is being hydrated from props. handleChange ignores
  // onChange events fired during this window — replaceBlocks + BlockNote's
  // async normalization emit several events that would otherwise persist a
  // lossy round-trip of what we just loaded.
  // After the load window closes, every onChange is treated as a real edit
  // — earlier we tried to gate on user-interaction events (keydown / paste)
  // but block deletion via the ⋮⋮ menu happens in a Mantine portal outside
  // the editor container and fired no DOM event we could see, so deletes
  // were silently dropped on save.
  const loadingRef = useRef(false)
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

    // Hold the gate closed until the load + BlockNote's normalization tick
    // settle.
    loadingRef.current = true

    void (async () => {
      try {
        const validBlocks = asBlockArray(contentBlocks)
        if (validBlocks) {
          // Lossless path: hydrate the JSON directly. Validated shape only —
          // malformed DB rows fall through to the markdown path below.
          // Cast back to replaceBlocks' schema-generic PartialBlock[] — we've
          // done the defensive runtime check; BlockNote will reject any
          // structurally-invalid block types with its own normalizer.
          type ReplaceArg = Parameters<typeof editor.replaceBlocks>[1]
          editor.replaceBlocks(editor.document, validBlocks as unknown as ReplaceArg)
          return
        }
        if (!content) return
        await loadFromMarkdown(editor, content)
      } finally {
        // Defer one tick so the onChange events that BlockNote emits as
        // part of replaceBlocks/normalization run with loadingRef still true.
        setTimeout(() => { loadingRef.current = false }, 0)
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

  const handleChange = useCallback(() => {
    if (readOnly) return
    // While props-driven load is happening, swallow the noisy normalization
    // events that BlockNote fires after replaceBlocks. After this window,
    // trust every onChange — it's a real document mutation.
    if (loadingRef.current) return

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
    }, 600)
  }, [editor, onSave, readOnly])

  // Keep refs pointing at the latest editor / onSave so the unmount
  // flush below can reach them without stale-closure bugs.
  const editorRef = useRef(editor)
  const onSaveRef = useRef(onSave)
  useEffect(() => {
    editorRef.current = editor
    onSaveRef.current = onSave
  })

  useEffect(() => {
    return () => {
      // On unmount (incl. navigation between pages), if a save is still
      // debouncing, flush it fire-and-forget instead of dropping the
      // user's edits. Cleanup is sync so we can't await — but the save
      // itself can finish in the background.
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
        const ed = editorRef.current
        const save = onSaveRef.current
        if (ed && save) {
          void (async () => {
            try {
              const blocks = ed.document
              const markdown = await ed.blocksToMarkdownLossy(blocks)
              await save(markdown, blocks)
            } catch { /* swallowed — page is already unmounted */ }
          })()
        }
      }
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
