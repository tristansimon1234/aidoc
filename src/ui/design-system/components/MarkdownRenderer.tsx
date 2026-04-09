import Markdown from 'react-markdown'
import { useImageLightbox } from './ImageLightbox.js'
import styles from './MarkdownRenderer.module.css'

interface MarkdownRendererProps {
  content: string
}

export function MarkdownRenderer({ content }: MarkdownRendererProps): React.ReactElement {
  const { lightbox, openLightbox } = useImageLightbox()

  return (
    <div className={styles.article}>
      <Markdown
        components={{
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
