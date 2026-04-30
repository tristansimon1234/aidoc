import React from 'react'
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion'
import type { Branding, Mock } from '../manifest.js'
import { MockFrame } from './MockFrame.js'
import { resolveTone, frameSurface, type ToneColors } from './tones.js'

interface DynamicMockProps {
  mock: Mock
  branding: Branding
  width?: number
  height?: number
}

/**
 * Renders a Mock DSL description into a Remotion-compatible animated UI.
 *
 * IMPORTANT: each element type has its OWN component below, with hooks
 * at the top of that component. The previous version called hooks
 * inside switch-case branches, which is a Rules-of-Hooks violation —
 * React silently bails on stale animation values, so the mock looked
 * static even though `useCurrentFrame()` was being read.
 *
 * Pattern: ElementRouter receives a tagged element, dispatches to the
 * correct component, no hooks of its own. Each leaf component reads
 * the frame + delay and applies fade-in / blink / pulse / counter as
 * appropriate.
 */
export const DynamicMock: React.FC<DynamicMockProps> = ({ mock, branding, width = 920, height = 580 }) => {
  const frameTone = mock.frame?.tone ?? 'light'
  const surface = frameSurface(frameTone)

  // Auto-stagger: Gemini routinely omits per-element `delay` despite the
  // prompt asking for it. Without staggers every element fades in at
  // frame 0 and the mock looks instant / static. Enforce a minimum
  // stagger of 0.25s × index when the LLM left delay undefined, capped
  // so a 12-element mock doesn't end up animating for 3 seconds.
  const STAGGER_PER_INDEX = 0.25
  const STAGGER_CAP = 3.0
  const enrichedElements = mock.elements.map((el, i) => {
    if ('delay' in el && el.delay !== undefined) return el
    if (el.type === 'spacer') return el
    return { ...el, delay: Math.min(i * STAGGER_PER_INDEX, STAGGER_CAP) } as typeof el
  })

  const inner = (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        padding: 28,
        display: 'flex',
        flexDirection: mock.layout === 'row' ? 'row' : 'column',
        gap: 12,
        color: surface.chromeFg,
        fontFamily: `${branding.fontFamily}, system-ui, sans-serif`,
      }}
    >
      {enrichedElements.map((el, i) => (
        <ElementRouter key={i} element={el} branding={branding} frameTone={frameTone} />
      ))}
    </div>
  )

  if (mock.frame) {
    return (
      <MockFrame url={mock.frame.url} tone={frameTone} width={width} height={height}>
        {inner}
      </MockFrame>
    )
  }
  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        borderRadius: 18,
        overflow: 'hidden',
        background: surface.bg,
        border: `1px solid ${surface.border}`,
        boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
      }}
    >
      {inner}
    </div>
  )
}

interface RouterProps {
  element: Mock['elements'][number]
  branding: Branding
  frameTone: 'light' | 'dark'
}

/**
 * Pure dispatcher — NO hooks. Routes the tagged element to the right
 * leaf component. Keeping hooks out of here is what guarantees React
 * sees a consistent hook order in DynamicMock's render.
 */
const ElementRouter: React.FC<RouterProps> = ({ element, branding, frameTone }) => {
  switch (element.type) {
    case 'header':         return <HeaderEl element={element} branding={branding} frameTone={frameTone} />
    case 'terminalLine':   return <TerminalLineEl element={element} branding={branding} frameTone={frameTone} />
    case 'blinkingCursor': return <BlinkingCursorEl element={element} branding={branding} />
    case 'card':           return <CardEl element={element} branding={branding} frameTone={frameTone} />
    case 'pill':           return <PillEl element={element} branding={branding} frameTone={frameTone} />
    case 'pulsingDot':     return <PulsingDotEl element={element} branding={branding} frameTone={frameTone} />
    case 'button':         return <ButtonEl element={element} branding={branding} />
    case 'input':          return <InputEl element={element} branding={branding} frameTone={frameTone} />
    case 'spacer':         return <div style={{ height: element.height ?? 12 }} />
    case 'text':           return <TextEl element={element} branding={branding} frameTone={frameTone} />
    case 'counter':        return <CounterEl element={element} branding={branding} />
    case 'avatar':         return <AvatarEl element={element} branding={branding} frameTone={frameTone} />
    case 'codeLine':       return <CodeLineEl element={element} branding={branding} frameTone={frameTone} />
    default:               return null
  }
}

// Bumped from 10 → 18 frames (≈0.6s @ 30fps) so the entry animation
// reads as motion rather than a flicker. Slide bumped from 8 → 18 px
// for the same reason; staggered with the auto-delay (0.25s/element)
// the result is a clear "elements typing in" feel.
const FADE_FRAMES = 18
const SLIDE_PX = 18

/** Hook: stagger fade-in + slide-up + tiny scale-in based on `delay`
 *  (seconds). Top-level in every leaf — never called inside a
 *  conditional. */
function useEntry(delay: number | undefined): { opacity: number; y: number; scale: number } {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const startFrame = Math.round((delay ?? 0) * fps)
  const t = interpolate(frame, [startFrame, startFrame + FADE_FRAMES], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  // Eased so the motion settles instead of stopping abruptly.
  const eased = 1 - Math.pow(1 - t, 3)
  return {
    opacity: t,
    y: SLIDE_PX * (1 - eased),
    scale: 0.96 + 0.04 * eased,
  }
}

// --- Leaf components, one per element type. Each has hooks at the top. ---

interface ElProps<T> { element: T; branding: Branding; frameTone: 'light' | 'dark' }
type Extract<T extends string> = Mock['elements'][number] extends infer U ? U extends { type: T } ? U : never : never

const HeaderEl: React.FC<ElProps<Extract<'header'>>> = ({ element, branding, frameTone }) => {
  const { opacity, y, scale } = useEntry(element.delay)
  const surface = frameSurface(frameTone)
  const status = element.statusText
    ? resolveTone(element.statusTone ?? 'success', branding, frameTone)
    : null
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        paddingBottom: 12,
        borderBottom: `1px solid ${surface.border}`,
        opacity, transform: `translateY(${y}px) scale(${scale})`,
        fontSize: 13, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        color: surface.chromeFg,
      }}
    >
      {element.icon && <IconGlyph name={element.icon} color={branding.accentColor} />}
      <span>{element.label}</span>
      {status && (
        <span
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 999,
            background: status.bg, color: status.fg,
            fontSize: 11, fontWeight: 700,
            textTransform: 'none', letterSpacing: 0,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: status.fg }} />
          {element.statusText}
        </span>
      )}
    </div>
  )
}

const TerminalLineEl: React.FC<ElProps<Extract<'terminalLine'>>> = ({ element, branding, frameTone }) => {
  const { opacity, y, scale } = useEntry(element.delay)
  const surface = frameSurface(frameTone)
  const colors: ToneColors = resolveTone(element.tone, branding, frameTone)
  return (
    <div
      style={{
        opacity, transform: `translateX(${(1 - opacity) * -16}px) translateY(${y}px) scale(${scale})`,
        transformOrigin: 'left center',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 14, color: colors.fg,
        paddingLeft: element.indent ? 16 : 0,
      }}
    >
      {element.prefix && (
        <span style={{ marginRight: 8, color: surface.chromeFg, opacity: 0.5 }}>{element.prefix}</span>
      )}
      {element.text}
      {element.trailingHighlight && (
        <span style={{ color: resolveTone('success', branding, frameTone).fg, marginLeft: 6 }}>
          {element.trailingHighlight}
        </span>
      )}
    </div>
  )
}

const BlinkingCursorEl: React.FC<{ element: Extract<'blinkingCursor'>; branding: Branding }> = ({ element, branding }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const delayFrames = Math.round((element.delay ?? 0) * fps)
  const cycleFrames = Math.round(0.9 * fps)
  const phase = ((frame - delayFrames) % cycleFrames) / cycleFrames
  const opacity = frame < delayFrames ? 0 : phase < 0.5 ? 1 : 0
  return (
    <div style={{ height: 16, display: 'flex', alignItems: 'center' }}>
      <span style={{ width: 2, height: 14, background: branding.accentColor, opacity }} />
    </div>
  )
}

const CardEl: React.FC<ElProps<Extract<'card'>>> = ({ element, branding, frameTone }) => {
  const { opacity, y, scale } = useEntry(element.delay)
  const surface = frameSurface(frameTone)
  // Gemini sometimes omits `rows` even though we require it. Defensive
  // default keeps the render alive — the card just shows its title.
  const rows = element.rows ?? []
  return (
    <div
      style={{
        opacity, transform: `translateY(${y}px) scale(${scale})`,
        padding: 14, borderRadius: 10,
        background: frameTone === 'dark' ? '#FFFFFF06' : '#00000004',
        border: `1px solid ${surface.border}`,
      }}
    >
      {element.title && (
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: surface.chromeFg,
          marginBottom: 10,
        }}>
          {element.title}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((r, i) => {
          const c = resolveTone(r.tone, branding, frameTone)
          return (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              fontSize: 14,
            }}>
              <span style={{ color: surface.chromeFg }}>{r.left}</span>
              {r.right && <span style={{ color: c.fg, fontWeight: 600 }}>{r.right}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const PillEl: React.FC<ElProps<Extract<'pill'>>> = ({ element, branding, frameTone }) => {
  const { opacity, y, scale } = useEntry(element.delay)
  const colors = resolveTone(element.tone, branding, frameTone)
  return (
    <span
      style={{
        opacity, transform: `translateY(${y}px) scale(${scale})`,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 12px', borderRadius: 999,
        background: colors.bg, color: colors.fg,
        fontSize: 12, fontWeight: 700,
        alignSelf: 'flex-start',
      }}
    >
      {element.text}
    </span>
  )
}

const PulsingDotEl: React.FC<ElProps<Extract<'pulsingDot'>>> = ({ element, branding, frameTone }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const colors = resolveTone(element.tone, branding, frameTone)
  const cycle = Math.round(1.4 * fps)
  const phase = (frame % cycle) / cycle
  const pulseOpacity = interpolate(phase, [0, 0.5, 1], [1, 0.35, 1])
  const size = element.size ?? 10
  return (
    <span style={{
      display: 'inline-block',
      width: size, height: size,
      borderRadius: '50%',
      background: colors.fg,
      opacity: pulseOpacity,
    }} />
  )
}

const ButtonEl: React.FC<{ element: Extract<'button'>; branding: Branding }> = ({ element, branding }) => {
  const { opacity, y, scale } = useEntry(element.delay)
  const isPrimary = element.primary !== false
  return (
    <div
      style={{
        opacity, transform: `translateY(${y}px) scale(${scale})`,
        alignSelf: 'flex-start',
        padding: '10px 22px', borderRadius: 8,
        background: isPrimary ? branding.accentColor : 'transparent',
        color: isPrimary ? '#FFFFFF' : branding.accentColor,
        border: isPrimary ? 'none' : `1px solid ${branding.accentColor}`,
        fontSize: 14, fontWeight: 600,
        letterSpacing: '-0.005em',
        boxShadow: isPrimary ? `0 6px 16px ${branding.accentColor}40` : 'none',
      }}
    >
      {element.label}
    </div>
  )
}

const InputEl: React.FC<ElProps<Extract<'input'>>> = ({ element, branding, frameTone }) => {
  const { opacity, y, scale } = useEntry(element.delay)
  const surface = frameSurface(frameTone)
  const filled = !!element.value
  return (
    <div
      style={{
        opacity, transform: `translateY(${y}px) scale(${scale})`,
        padding: '10px 14px', borderRadius: 8,
        background: frameTone === 'dark' ? '#FFFFFF08' : '#FFFFFF',
        border: `1px solid ${element.focused ? branding.accentColor : surface.border}`,
        boxShadow: element.focused ? `0 0 0 3px ${branding.accentColor}25` : 'none',
        fontSize: 14, color: filled ? surface.chromeFg : `${surface.chromeFg}80`,
      }}
    >
      {filled ? element.value : element.placeholder}
    </div>
  )
}

const TextEl: React.FC<ElProps<Extract<'text'>>> = ({ element, branding, frameTone }) => {
  const { opacity, y, scale } = useEntry(element.delay)
  const colors = resolveTone(element.tone, branding, frameTone)
  const sizeMap = { xs: 11, sm: 13, md: 15, lg: 18, xl: 22 } as const
  return (
    <div style={{
      opacity, transform: `translateY(${y}px) scale(${scale})`,
      fontSize: sizeMap[element.size ?? 'md'],
      fontWeight: element.weight === 'bold' ? 700 : 400,
      color: colors.fg,
      lineHeight: 1.4,
    }}>
      {element.text}
    </div>
  )
}

const CounterEl: React.FC<{ element: Extract<'counter'>; branding: Branding }> = ({ element, branding }) => {
  const { opacity, y, scale } = useEntry(element.delay)
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const startFrame = Math.round((element.delay ?? 0) * fps)
  const animFrames = Math.round(1.2 * fps)
  const t = interpolate(frame, [startFrame, startFrame + animFrames], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  })
  const eased = 1 - Math.pow(1 - t, 3)
  // Defensive: Gemini sometimes drops from/to. Default to 0 → 100 so
  // the counter still ticks meaningfully instead of rendering NaN.
  const from = typeof element.from === 'number' ? element.from : 0
  const to = typeof element.to === 'number' ? element.to : 100
  const value = Math.round(from + (to - from) * eased)
  return (
    <div style={{
      opacity, transform: `translateY(${y}px) scale(${scale})`,
      fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em',
      color: branding.accentColor,
      fontFeatureSettings: '"tnum"',
    }}>
      {element.prefix ?? ''}{value.toLocaleString()}{element.suffix ?? ''}
    </div>
  )
}

const AvatarEl: React.FC<ElProps<Extract<'avatar'>>> = ({ element, branding, frameTone }) => {
  const { opacity, y, scale } = useEntry(element.delay)
  const colors = resolveTone(element.tone, branding, frameTone)
  return (
    <span style={{
      opacity, transform: `translateY(${y}px) scale(${scale})`,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 36, height: 36, borderRadius: '50%',
      background: colors.bg, color: colors.fg,
      fontSize: 13, fontWeight: 700,
    }}>
      {element.initials}
    </span>
  )
}

const CodeLineEl: React.FC<ElProps<Extract<'codeLine'>>> = ({ element, branding, frameTone }) => {
  const { opacity, y, scale } = useEntry(element.delay)
  const surface = frameSurface(frameTone)
  // Defensive: Gemini may emit a codeLine without tokens.
  const tokens = element.tokens ?? []
  return (
    <div style={{
      opacity, transform: `translateY(${y}px) scale(${scale})`,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13, display: 'flex', gap: 14,
    }}>
      {element.lineNumber !== undefined && (
        <span style={{ color: surface.chromeFg, opacity: 0.4, width: 24, textAlign: 'right' }}>
          {element.lineNumber}
        </span>
      )}
      <span>
        {tokens.map((tk, i) => {
          const c = resolveTone(tk.tone, branding, frameTone)
          return <span key={i} style={{ color: c.fg }}>{tk.text}</span>
        })}
      </span>
    </div>
  )
}

/** Inline glyph for header icons. Anything unknown renders a small dot
 *  so a typo from the LLM doesn't break the layout. */
const IconGlyph: React.FC<{ name: string; color: string }> = ({ name, color }) => {
  const size = 14
  const stroke = color
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (name) {
    case 'plug':
      return <svg {...common}><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z" /><path d="M12 18v4" /></svg>
    case 'mic':
      return <svg {...common}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" /></svg>
    case 'check':
      return <svg {...common}><path d="M5 12l5 5L20 7" /></svg>
    case 'message':
      return <svg {...common}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
    case 'search':
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg>
    case 'zap':
      return <svg {...common}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
    case 'code':
      return <svg {...common}><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" /></svg>
    case 'settings':
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
    default:
      return <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: color }} />
  }
}
