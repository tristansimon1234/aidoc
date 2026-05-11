import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { normalizeHex } from '../../../shared/design/colors.js'
import styles from './ColorPicker.module.css'

/**
 * Modern hex color picker. Replaces the native `<input type="color">` which
 * looks like a button-store castoff and varies per OS. UI:
 *
 *   ┌─────────────┐
 *   │  S/V plane  │   click + drag → sets saturation (X) and value (Y)
 *   └─────────────┘
 *   ━━━━●━━━━━━━━━   hue slider (0-360°)
 *   #RRGGBB
 *   [preset palette]
 *
 * Implementation notes:
 *  - Internal state is HSV (intuitive for users) but the parent API is hex.
 *    We convert on every commit; `normalizeHex` keeps the persisted form
 *    canonical (`#RRGGBB` uppercase).
 *  - The popover floats via `position: fixed` + JS-computed anchor — no
 *    overflow-clip surprises inside scrollable cards.
 *  - Click-outside + Escape close. Focus trap is intentionally NOT
 *    implemented; the picker is a non-blocking tool, not a modal.
 *  - Pointer events use capture-on-down → window-level move → release on
 *    up, so dragging continues even when the cursor leaves the panel.
 */

interface ColorPickerProps {
  value: string                // `#RRGGBB` hex
  onChange: (hex: string) => void
  /** Optional preset row shown below the inputs. */
  presets?: string[]
  /** Optional trigger label (defaults to the hex value). */
  label?: string
  /** Optional aria-label for the trigger button. */
  ariaLabel?: string
}

type HSV = { h: number; s: number; v: number }

function hexToHsv(hex: string): HSV {
  const norm = normalizeHex(hex) ?? '#000000'
  const r = parseInt(norm.slice(1, 3), 16) / 255
  const g = parseInt(norm.slice(3, 5), 16) / 255
  const b = parseInt(norm.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const v = max
  const s = max === 0 ? 0 : d / max
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s, v }
}

function hsvToHex({ h, s, v }: HSV): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const to2 = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return ('#' + to2(r) + to2(g) + to2(b)).toUpperCase()
}

function hueToPureHex(h: number): string {
  return hsvToHex({ h, s: 1, v: 1 })
}

export function ColorPicker({ value, onChange, presets, label, ariaLabel }: ColorPickerProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(value))
  const [hexDraft, setHexDraft] = useState(value.toUpperCase())
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const svRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)

  // Sync internal HSV whenever the parent value drifts (external set).
  useEffect(() => {
    const norm = normalizeHex(value)
    if (norm && norm !== hsvToHex(hsv)) {
      setHsv(hexToHsv(norm))
      setHexDraft(norm)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // Anchor the popover under the trigger when opened or when the trigger
  // moves (scroll / resize while open).
  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const t = triggerRef.current
      if (!t) return
      const r = t.getBoundingClientRect()
      const popWidth = 248
      const popHeight = 320
      let left = r.left
      if (left + popWidth > window.innerWidth - 8) left = window.innerWidth - popWidth - 8
      if (left < 8) left = 8
      let top = r.bottom + 6
      if (top + popHeight > window.innerHeight - 8) top = r.top - popHeight - 6
      setAnchor({ top, left })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  // Click-outside + Escape to close.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null
      if (popRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const commit = useCallback((next: HSV): void => {
    setHsv(next)
    const hex = hsvToHex(next)
    setHexDraft(hex)
    onChange(hex)
  }, [onChange])

  // S/V plane drag — translates pointer position to (saturation, value).
  const startSvDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    const el = svRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const move = (cx: number, cy: number): void => {
      const x = Math.max(0, Math.min(1, (cx - rect.left) / rect.width))
      const y = Math.max(0, Math.min(1, (cy - rect.top) / rect.height))
      commit({ h: hsv.h, s: x, v: 1 - y })
    }
    move(e.clientX, e.clientY)
    const onMove = (ev: PointerEvent): void => { move(ev.clientX, ev.clientY) }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Hue slider drag — translates pointer X to hue degrees.
  const startHueDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    const el = hueRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const move = (cx: number): void => {
      const x = Math.max(0, Math.min(1, (cx - rect.left) / rect.width))
      commit({ h: x * 360, s: hsv.s, v: hsv.v })
    }
    move(e.clientX)
    const onMove = (ev: PointerEvent): void => { move(ev.clientX) }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Hex text input — commit only on blur / Enter, so partial typing
  // doesn't blow up the picker on every keystroke.
  const onHexBlur = (): void => {
    const norm = normalizeHex(hexDraft)
    if (norm) {
      const next = hexToHsv(norm)
      setHsv(next)
      setHexDraft(norm)
      onChange(norm)
    } else {
      // Revert visible text to the last good value.
      setHexDraft(hsvToHex(hsv))
    }
  }

  const display = (normalizeHex(value) ?? '#000000').toUpperCase()

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel ?? `Color picker, current value ${display}`}
      >
        <span className={styles.triggerSwatch}>
          <span className={styles.triggerSwatchInner} style={{ background: display }} />
        </span>
        <span>{label ?? display}</span>
      </button>

      {open && anchor && createPortal(
        <div ref={popRef} className={styles.popover} style={{ top: anchor.top, left: anchor.left }}>
          <div
            ref={svRef}
            className={styles.svPlane}
            style={{ background: hueToPureHex(hsv.h) }}
            onPointerDown={startSvDrag}
          >
            <div className={styles.svPlaneSat} />
            <div className={styles.svPlaneVal} />
            <div
              className={styles.dot}
              style={{
                left: `${hsv.s * 100}%`,
                top: `${(1 - hsv.v) * 100}%`,
                background: hsvToHex(hsv),
              }}
            />
          </div>

          <div ref={hueRef} className={styles.hueSlider} onPointerDown={startHueDrag}>
            <div className={styles.hueThumb} style={{ left: `${(hsv.h / 360) * 100}%`, background: hueToPureHex(hsv.h) }} />
          </div>

          <div className={styles.bottomRow}>
            <input
              type="text"
              className={styles.hexInput}
              value={hexDraft}
              onChange={(e) => setHexDraft(e.target.value)}
              onBlur={onHexBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                else if (e.key === 'Escape') {
                  setHexDraft(hsvToHex(hsv))
                  setOpen(false)
                }
              }}
              spellCheck={false}
              maxLength={7}
              aria-label="Hex value"
            />
          </div>

          {presets && presets.length > 0 && (
            <div className={styles.presets} role="listbox" aria-label="Color presets">
              {presets.map((p) => {
                const norm = normalizeHex(p) ?? p
                const active = norm.toUpperCase() === display
                return (
                  <button
                    key={norm}
                    type="button"
                    className={`${styles.presetSwatch} ${active ? styles.presetSwatchActive : ''}`}
                    style={{ background: norm }}
                    onClick={() => commit(hexToHsv(norm))}
                    aria-label={`Preset ${norm}`}
                    title={norm}
                  />
                )
              })}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
