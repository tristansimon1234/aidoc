import { useState, useEffect, useMemo, useRef } from 'react'
import styles from './TableOfContents.module.css'

interface TocItem {
  id: string
  text: string
  level: number
}

interface TableOfContentsProps {
  /** Markdown content to extract headings from */
  content: string
  /** The scrollable container to observe and scroll within */
  scrollContainer?: HTMLElement | null
}

function extractHeadings(markdown: string): TocItem[] {
  const lines = markdown.split('\n')
  const headings: TocItem[] = []
  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+)/)
    if (match) {
      const level = match[1]!.length
      const text = match[2]!.replace(/[*_`\[\]]/g, '').trim()
      const id = text.toLowerCase().replace(/[^a-z0-9\u00C0-\u024F]+/gi, '-').replace(/^-|-$/g, '')
      headings.push({ id, text, level })
    }
  }
  return headings
}

export function TableOfContents({ content, scrollContainer }: TableOfContentsProps): React.ReactElement | null {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const headings = useMemo(() => extractHeadings(content), [content])

  // Observe which heading is currently in view
  useEffect(() => {
    if (headings.length === 0) return

    const container = scrollContainer ?? document.querySelector('[class*="content"]')
    if (!container) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
          }
        }
      },
      { root: container as Element, rootMargin: '-10% 0px -80% 0px', threshold: 0 },
    )

    // Find heading elements in the DOM
    const elements: Element[] = []
    for (const h of headings) {
      const el = container.querySelector(`#${CSS.escape(h.id)}`)
      if (el) {
        observer.observe(el)
        elements.push(el)
      }
    }

    return () => observer.disconnect()
  }, [headings, scrollContainer])

  const handleMouseEnter = (): void => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setHovered(true)
  }

  const handleMouseLeave = (): void => {
    timeoutRef.current = setTimeout(() => setHovered(false), 300)
  }

  const handleClick = (id: string): void => {
    const container = scrollContainer ?? document.querySelector('[class*="content"]')
    if (!container) return
    const el = container.querySelector(`#${CSS.escape(id)}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setActiveId(id)
    }
  }

  if (headings.length < 2) return null

  return (
    <div
      className={`${styles.wrapper} ${hovered ? styles.wrapperOpen : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Collapsed indicator — two small lines */}
      <div className={`${styles.indicator} ${hovered ? styles.indicatorHidden : ''}`}>
        <span className={styles.indicatorLine} />
        <span className={`${styles.indicatorLine} ${styles.indicatorLineShort}`} />
      </div>

      {/* Expanded TOC panel */}
      <div className={`${styles.panel} ${hovered ? styles.panelVisible : ''}`}>
        <div className={styles.panelHeader}>On this page</div>
        <nav className={styles.nav}>
          {headings.map((h) => (
            <button
              key={h.id}
              className={`${styles.tocItem} ${activeId === h.id ? styles.tocItemActive : ''}`}
              style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
              onClick={() => handleClick(h.id)}
            >
              {h.text}
            </button>
          ))}
        </nav>
      </div>
    </div>
  )
}
