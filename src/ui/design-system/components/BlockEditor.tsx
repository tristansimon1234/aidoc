import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { BlockNoteSchema, defaultBlockSpecs, filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core'
import type { BlockNoteEditor, PartialBlock } from '@blocknote/core'
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

/** BlockNote editor parameterized by our schema (default blocks + Callout). */
type Editor = BlockNoteEditor<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>

/** Minimal structural contract for a BlockNote document block. Guard
 *  run before we hand raw JSONB from the DB to `replaceBlocks`. */
interface BlockLike { type: string; children?: unknown; content?: unknown; props?: Record<string, unknown>; [k: string]: unknown }

function isBlockLike(value: unknown): value is BlockLike {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

function asBlockArray(value: unknown): BlockLike[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  if (!value.every(isBlockLike)) return null
  return value as BlockLike[]
}

function getCalloutItems(editor: Editor): DefaultReactSuggestionItem[] {
  const insert = (type: CalloutType) => (): void => {
    // `callout` is our custom block; its PartialBlock variant isn't part of
    // the default union so we assert through PartialBlock<typeof schema...>.
    insertOrUpdateBlockForSlashMenu(editor, {
      type: 'callout',
      props: { calloutType: type },
    } as PartialBlock<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>)
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

interface InlineTextRun { type: 'text'; text: string; [k: string]: unknown }

function isInlineTextRun(value: unknown): value is InlineTextRun {
  return typeof value === 'object'
    && value !== null
    && (value as { type?: unknown }).type === 'text'
    && typeof (value as { text?: unknown }).text === 'string'
}

function promoteCallouts(blocks: BlockLike[]): BlockLike[] {
  return blocks.map((b) => {
    const children = Array.isArray(b.children) ? (b.children as unknown[]).filter(isBlockLike) : []
    const withChildren: BlockLike = children.length > 0
      ? { ...b, children: promoteCallouts(children) }
      : b
    if (withChildren.type !== 'quote' || !Array.isArray(withChildren.content)) return withChildren
    const content = withChildren.content as unknown[]
    const first = content[0]
    if (!isInlineTextRun(first)) return withChildren
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
    const newContent: unknown[] = stripped.length > 0
      ? [{ ...first, text: stripped }, ...content.slice(1)]
      : content.slice(1)
    return {
      ...withChildren,
      type: 'callout',
      props: { ...(withChildren.props ?? {}), calloutType },
      content: newContent,
    }
  })
}

// Markdown → HTML → blocks, with a safety fallback on the legacy markdown
// parser if HTML import ever throws. Kept module-level so the load effect
// reads linearly; any failure is logged so silent blank editors don't
// happen unnoticed.
// Parameters-derived replaceBlocks shape — keeps us honest against BlockNote's
// schema-generic PartialBlock union without having to reconstruct it here.
type ReplaceArg = Parameters<Editor['replaceBlocks']>[1]

async function loadFromMarkdown(editor: Editor, markdown: string): Promise<void> {
  try {
    const html = await marked.parse(markdown)
    const blocks = await editor.tryParseHTMLToBlocks(html)
    editor.replaceBlocks(editor.document, promoteCallouts(blocks as unknown as BlockLike[]) as unknown as ReplaceArg)
  } catch (err) {
    console.warn('[BlockEditor] HTML-first import failed, falling back to markdown parser', err)
    try {
      const blocks = await editor.tryParseMarkdownToBlocks(markdown)
      editor.replaceBlocks(editor.document, promoteCallouts(blocks as unknown as BlockLike[]) as unknown as ReplaceArg)
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
  type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed'
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  // Tick to refresh the "Saved Xs ago" relative timestamp.
  const [, setNowTick] = useState(0)

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Has the editor's content changed since the last successful save?
  // Set to true on every real onChange; cleared at the start of each save
  // attempt so that edits arriving DURING the save flip it back to true and
  // trigger a re-flush. This is the "dirty bit" that drives the unload guard
  // and the queued-save logic.
  const dirtyRef = useRef(false)
  // True while a save call is awaiting the server. Used to serialise saves
  // so two onSave promises never race — the second one waits via the
  // pending-flush flag below.
  const inFlightRef = useRef(false)
  const initializedRef = useRef(false)
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

  // Hydrate the editor ONCE. After mount, the editor owns its content —
  // we never re-import from props, even when the parent re-renders with
  // freshly-saved data round-tripped through Postgres. Doing so used to
  // jolt the cursor mid-typing because BlockNote's JSON normalization is
  // not byte-stable across an API roundtrip (key order, default fills).
  //
  // Parents that need to force a fresh load (AI regen, restore previous
  // version, page navigation) bump the React `key` prop to remount this
  // component — see `PageView` which composes `${pageId}-${externalRev}`.
  useEffect(() => {
    if (!editor) return
    if (initializedRef.current) return
    initializedRef.current = true

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

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

  // Keep refs pointing at the latest editor / onSave so async callbacks
  // (debounce timer, retry timer, unmount flush) can reach them without
  // stale-closure bugs.
  const editorRef = useRef(editor)
  const onSaveRef = useRef(onSave)
  useEffect(() => {
    editorRef.current = editor
    onSaveRef.current = onSave
  })

  // Single save engine. Serialises against itself via inFlightRef and
  // retries transient failures with exponential backoff. dirtyRef is
  // cleared optimistically at the start so any edits arriving during the
  // network round-trip flip it back to true and queue a re-flush.
  const performSave = useCallback(async (attempt = 0): Promise<void> => {
    const ed = editorRef.current
    const save = onSaveRef.current
    if (!ed || !save) return

    if (inFlightRef.current) {
      // A save is already running — when it returns it'll re-check
      // dirtyRef and re-flush. Nothing to do here.
      return
    }
    if (!dirtyRef.current) return

    inFlightRef.current = true
    dirtyRef.current = false
    setSaveStatus('saving')

    try {
      const blocks = ed.document
      const markdown = await ed.blocksToMarkdownLossy(blocks)
      await save(markdown, blocks)
      inFlightRef.current = false
      setLastSavedAt(Date.now())
      // If the user kept typing during the save, dirtyRef was flipped back
      // on by handleChange — flush again immediately.
      if (dirtyRef.current) {
        setSaveStatus('saving')
        void performSave(0)
      } else {
        setSaveStatus('saved')
      }
    } catch {
      inFlightRef.current = false
      // Edits that triggered this save are still unsaved — restore the
      // dirty flag so the unload guard fires and the next user keystroke
      // triggers a fresh debounce.
      dirtyRef.current = true
      const backoffMs = [1000, 3000, 6000]
      const wait = backoffMs[attempt]
      if (wait !== undefined) {
        setSaveStatus('saving')
        retryTimeoutRef.current = setTimeout(() => {
          retryTimeoutRef.current = null
          void performSave(attempt + 1)
        }, wait)
      } else {
        setSaveStatus('failed')
      }
    }
  }, [])

  const handleChange = useCallback(() => {
    if (readOnly) return
    // While props-driven load is happening, swallow the noisy normalization
    // events that BlockNote fires after replaceBlocks. After this window,
    // trust every onChange — it's a real document mutation.
    if (loadingRef.current) return

    dirtyRef.current = true
    // Fresh edit supersedes any pending retry — drop the wait, debounce
    // anew, the user's latest content will be the one saved.
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null
      void performSave()
    }, 600)
  }, [readOnly, performSave])

  // beforeunload guard — block tab close / refresh while there are
  // unsaved edits or an in-flight save (network might be killed).
  // Modern browsers ignore the message string and show their own
  // localized prompt; what matters is that preventDefault fires.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): void => {
      if (dirtyRef.current || inFlightRef.current) {
        e.preventDefault()
        // Legacy browsers — required for the prompt to show in some.
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Tick the relative-time display every 5s while we're showing
  // "Saved Xs ago" — cheap, only runs in the saved state.
  useEffect(() => {
    if (saveStatus !== 'saved') return
    const id = setInterval(() => setNowTick((n) => n + 1), 5000)
    return () => clearInterval(id)
  }, [saveStatus])

  useEffect(() => {
    return () => {
      // On unmount (incl. navigation between pages), if there are unsaved
      // edits OR a pending debounce, flush fire-and-forget instead of
      // dropping the user's edits. Cleanup is sync so we can't await —
      // but the request itself can complete in the background while the
      // new page mounts.
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
      if (dirtyRef.current && !inFlightRef.current) {
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

  const handleManualRetry = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
    void performSave(0)
  }, [performSave])

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <SaveIndicator status={saveStatus} lastSavedAt={lastSavedAt} onRetry={handleManualRetry} />
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

function formatSavedAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

function SaveIndicator({
  status,
  lastSavedAt,
  onRetry,
}: {
  status: 'idle' | 'saving' | 'saved' | 'failed'
  lastSavedAt: number | null
  onRetry: () => void
}): React.ReactElement | null {
  if (status === 'idle') return null
  if (status === 'saving') {
    return <span className={styles.saveIndicator}>Saving…</span>
  }
  if (status === 'failed') {
    return (
      <span className={`${styles.saveIndicator} ${styles.saveIndicatorFailed}`}>
        Save failed
        <button type="button" className={styles.saveRetryBtn} onClick={onRetry}>Retry</button>
      </span>
    )
  }
  // saved
  const rel = lastSavedAt ? formatSavedAgo(Date.now() - lastSavedAt) : ''
  return <span className={styles.saveIndicator}>Saved {rel}</span>
}
