import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import styles from './TableOfContents.module.css'

interface TocItem {
  index: number
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
  let idx = 0
  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+)/)
    if (match) {
      const level = match[1]!.length
      const text = match[2]!.replace(/[*_`\[\]]/g, '').trim()
      headings.push({ index: idx, text, level })
      idx++
    }
  }
  return headings
}

/** Find all h1/h2/h3 elements inside a container (works with both MarkdownRenderer and BlockNote) */
function findHeadingElements(container: Element): Element[] {
  return Array.from(container.querySelectorAll('h1, h2, h3')).filter((el) => {
    // Skip the page title input (if it exists)
    if (el.tagName === 'INPUT') return false
    // Only include headings with actual text content
    const text = el.textContent?.trim()
    return text && text.length > 0
  })
}

export function TableOfContents({ content, scrollContainer }: TableOfContentsProps): React.ReactElement | null {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [hovered, setHovered] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const headingElsRef = useRef<Element[]>([])

  const headings = useMemo(() => extractHeadings(content), [content])

  // Find and observe heading elements in the DOM
  useEffect(() => {
    if (headings.length === 0) return

    // Small delay to let the DOM render (BlockNote is async)
    const timer = setTimeout(() => {
      const container = scrollContainer ?? document.querySelector('[class*="contentArea"]') ?? document.querySelector('[class*="contentWrapper"]')
      if (!container) return

      const els = findHeadingElements(container)
      headingElsRef.current = els

      if (els.length === 0) return

      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const idx = els.indexOf(entry.target)
              if (idx !== -1) setActiveIndex(idx)
            }
          }
        },
        { rootMargin: '-10% 0px -80% 0px', threshold: 0 },
      )

      for (const el of els) observer.observe(el)

      return () => observer.disconnect()
    }, 500)

    return () => clearTimeout(timer)
  }, [headings, scrollContainer, content])

  const handleMouseEnter = (): void => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setHovered(true)
  }

  const handleMouseLeave = (): void => {
    timeoutRef.current = setTimeout(() => setHovered(false), 300)
  }

  const handleClick = useCallback((index: number): void => {
    const el = headingElsRef.current[index]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setActiveIndex(index)
    }
  }, [])

  if (headings.length < 2) return null

  return (
    <div
      className={`${styles.wrapper} ${hovered ? styles.wrapperOpen : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Collapsed indicator */}
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
              key={h.index}
              className={`${styles.tocItem} ${activeIndex === h.index ? styles.tocItemActive : ''}`}
              style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
              onClick={() => handleClick(h.index)}
            >
              {h.text}
            </button>
          ))}
        </nav>
      </div>
    </div>
  )
}
