import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import { useImageLightbox } from './ImageLightbox.js'
import styles from './MarkdownRenderer.module.css'

interface MarkdownRendererProps {
  content: string
}

function headingId(children: ReactNode): string {
  const text = extractText(children)
  return text.toLowerCase().replace(/[^a-z0-9\u00C0-\u024F]+/gi, '-').replace(/^-|-$/g, '')
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

// GitHub-style alert marker. Users write:
//   > [!TIP]
//   > content
// and we render it as a styled callout.
const CALLOUT_MARKER = /^\s*\[!(NOTE|INFO|TIP|WARNING|DANGER|CAUTION)\]\s*\n?/i

function detectCallout(children: ReactNode): { type: string; stripped: ReactNode } | null {
  const text = extractText(children)
  const match = CALLOUT_MARKER.exec(text)
  if (!match) return null
  const type = match[1]!.toUpperCase()
  const stripped = stripLeadingMarker(children, match[0].length)
  return { type, stripped }
}

// Walk the React tree and remove the first `n` characters of leading text — so
// `[!TIP]\n` disappears from the rendered content while keeping the rest of
// the blockquote formatting intact.
function stripLeadingMarker(node: ReactNode, remaining: number): ReactNode {
  if (remaining <= 0 || node == null || typeof node === 'boolean') return node
  if (typeof node === 'string') {
    return node.length <= remaining ? '' : node.slice(remaining)
  }
  if (Array.isArray(node)) {
    const out: ReactNode[] = []
    let left = remaining
    for (const child of node) {
      if (left <= 0) { out.push(child); continue }
      const childText = extractText(child)
      if (childText.length <= left) {
        left -= childText.length
        // Drop the node entirely
      } else {
        out.push(stripLeadingMarker(child, left))
        left = 0
      }
    }
    return out
  }
  if (typeof node === 'object' && 'props' in node) {
    const n = node as { props: { children?: ReactNode }; type?: unknown; key?: string | number | null }
    const stripped = stripLeadingMarker(n.props.children, remaining)
    // React.cloneElement-like shallow clone preserving type + key
    return { ...node, props: { ...n.props, children: stripped } } as ReactNode
  }
  return node
}

export function MarkdownRenderer({ content }: MarkdownRendererProps): React.ReactElement {
  const { lightbox, openLightbox } = useImageLightbox()

  return (
    <div className={styles.article}>
      <Markdown
        components={{
          h1: ({ children, ...props }) => <h1 id={headingId(children)} {...props}>{children}</h1>,
          h2: ({ children, ...props }) => <h2 id={headingId(children)} {...props}>{children}</h2>,
          h3: ({ children, ...props }) => <h3 id={headingId(children)} {...props}>{children}</h3>,
          img: ({ src, alt, ...props }) => (
            <img
              {...props}
              src={src}
              alt={alt ?? ''}
              style={{ cursor: 'zoom-in' }}
              onClick={() => { if (src) openLightbox(src) }}
            />
          ),
          blockquote: ({ children, ...props }) => {
            const callout = detectCallout(children)
            if (!callout) return <blockquote {...props}>{children}</blockquote>
            return (
              <blockquote {...props} data-callout-type={callout.type}>
                {callout.stripped}
              </blockquote>
            )
          },
        }}
      >
        {content}
      </Markdown>
      {lightbox}
    </div>
  )
}
