import { useState, useRef, useId, cloneElement, isValidElement } from 'react'
import type { ReactElement, ReactNode, FocusEvent, MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import styles from './Tooltip.module.css'

type Placement = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  content: ReactNode
  children: ReactElement
  placement?: Placement
  delay?: number
}

interface Coords { x: number; y: number; placement: Placement }

/**
 * Lightweight tooltip — no external lib. Renders into document.body via
 * a portal so it escapes any overflow:hidden parent (sticky bars,
 * scroll containers, etc.). Listens to mouse + focus events so it's
 * keyboard-accessible.
 */
export function Tooltip({ content, children, placement = 'top', delay = 300 }: TooltipProps): ReactElement {
  const [coords, setCoords] = useState<Coords | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const id = useId()

  const computeCoords = (el: HTMLElement): Coords => {
    const r = el.getBoundingClientRect()
    const margin = 8
    switch (placement) {
      case 'bottom':
        return { x: r.left + r.width / 2, y: r.bottom + margin, placement }
      case 'left':
        return { x: r.left - margin, y: r.top + r.height / 2, placement }
      case 'right':
        return { x: r.right + margin, y: r.top + r.height / 2, placement }
      case 'top':
      default:
        return { x: r.left + r.width / 2, y: r.top - margin, placement }
    }
  }

  const show = (el: HTMLElement): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setCoords(computeCoords(el))
    }, delay)
  }

  const hide = (): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setCoords(null)
  }

  if (!isValidElement(children)) return children

  // We attach handlers + ref by cloning. Preserve any existing handlers on
  // the child so callers can still wire onClick / onMouseEnter themselves.
  const childProps = children.props as {
    onMouseEnter?: (e: MouseEvent<HTMLElement>) => void
    onMouseLeave?: (e: MouseEvent<HTMLElement>) => void
    onFocus?: (e: FocusEvent<HTMLElement>) => void
    onBlur?: (e: FocusEvent<HTMLElement>) => void
    'aria-describedby'?: string
  }

  const wrappedChild = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
    },
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      show(e.currentTarget)
      childProps.onMouseEnter?.(e)
    },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => {
      hide()
      childProps.onMouseLeave?.(e)
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      show(e.currentTarget)
      childProps.onFocus?.(e)
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      hide()
      childProps.onBlur?.(e)
    },
    'aria-describedby': coords ? id : childProps['aria-describedby'],
  } as Record<string, unknown>)

  const tooltip = coords ? (
    <div
      id={id}
      role="tooltip"
      className={`${styles.tooltip} ${styles[`placement-${coords.placement}`]}`}
      style={{ left: coords.x, top: coords.y }}
    >
      {content}
    </div>
  ) : null

  return (
    <>
      {wrappedChild}
      {tooltip && typeof document !== 'undefined' && createPortal(tooltip, document.body)}
    </>
  )
}
