import { useEffect, useRef, useState, useCallback } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import styles from './BlockEditor.module.css'

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

  const getTheme = (): 'dark' | 'light' => {
    if (typeof document === 'undefined') return 'dark'
    return (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') ?? 'dark'
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
        const blocks = await editor.tryParseMarkdownToBlocks(content)
        editor.replaceBlocks(editor.document, blocks)
      } catch {
        // markdown parsing failed
      }
    })()
  }, [editor, content])

  const handleChange = useCallback(() => {
    if (readOnly) return

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
    <div style={{ position: 'relative' }}>
      {saving && <span className={styles.saving}>Saving...</span>}
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        onChange={handleChange}
        theme={theme}
      />
    </div>
  )
}
