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
        }}
      >
        {content}
      </Markdown>
      {lightbox}
    </div>
  )
}
