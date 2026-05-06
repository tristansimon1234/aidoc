import React from 'react'
// Wildcard import — every lucide-react icon is now reachable as
// Icons[name] at runtime. Bundle cost ~500KB but the Remotion bundle is
// cached server-side and shipped once per deploy, not per render. Trade
// pays for itself the first time the LLM picks an icon we hadn't
// pre-listed (was 70, lucide has ~1500).
import * as LucideIcons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  ResponsiveContainer,
  LineChart, Line,
  AreaChart, Area,
  BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell,
} from 'recharts'
import type { Branding } from '../manifest.js'

/**
 * Helpers exposed to LLM-generated mock code via the `Remotion` namespace.
 * They live on the bundle side, not the LLM side — so Gemini doesn't burn
 * its 2500-char budget rewriting a browser chrome on every scene; it just
 * calls <Remotion.MockFrame url="…">…</Remotion.MockFrame>. Same for icons:
 * a curated subset of lucide-react is exposed as Remotion.Icons.Plug, etc.
 *
 * The cost of every helper is amortised across all scenes — they are
 * defined once in the bundle and the LLM references them by name.
 */

interface MockFrameProps {
  /** URL bar text. Falls back to a placeholder if omitted. */
  url?: string
  /** Light interior (#FFFFFF) for product UIs / dashboards / settings,
   *  dark interior (#0B0B0F) for terminal / code / chat-with-AI mocks.
   *  Default 'light'. */
  tone?: 'light' | 'dark'
  children?: React.ReactNode
  /** Inline style override merged onto the outer container. Use for
   *  entry animations: \`style={{ opacity, transform: 'translateY(...)' }}\`. */
  style?: React.CSSProperties
}

/**
 * Designed browser-window chrome. Renders rounded corners + soft shadow
 * + macOS traffic-light dots + URL bar + content area. The interior tone
 * picks the chrome theme (chrome bg, border, URL color) consistently.
 *
 * **OPTIONAL — pick the cadrage per scene.** Earlier guidance forced
 * MockFrame as the outermost element of every mock; that converged every
 * video onto a "look at our app in a Chrome window" aesthetic. Now it's
 * one of several cadrages the architect picks from (browser / mobile /
 * terminal / fullbleed / split). Use MockFrame ONLY when the scene
 * genuinely benefits from a browser frame; otherwise compose the cadrage
 * from primitives.
 */
export const MockFrame: React.FC<MockFrameProps> = ({ url, tone = 'light', children, style }) => {
  const isDark = tone === 'dark'
  const surface = {
    bg:       isDark ? '#0B0B0F' : '#FFFFFF',
    border:   isDark ? '#FFFFFF18' : '#0000001A',
    chromeBg: isDark ? '#16161A' : '#F8FAFC',
    chromeFg: isDark ? '#FFFFFF80' : '#52525B',
    urlBg:    isDark ? '#FFFFFF10' : '#FFFFFF',
  }
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        maxWidth: '100%',
        borderRadius: 16,
        overflow: 'hidden',
        background: surface.bg,
        border: `1px solid ${surface.border}`,
        // Layered shadow: a soft far blur + a tight close one. Lower-opacity
        // far layer means the shadow falls off gracefully into the canvas
        // instead of cutting hard at any container's overflow boundary.
        boxShadow: isDark
          ? '0 1px 2px rgba(0,0,0,0.18), 0 24px 48px -12px rgba(0,0,0,0.30), 0 60px 120px -20px rgba(0,0,0,0.20)'
          : '0 1px 2px rgba(0,0,0,0.04), 0 24px 48px -12px rgba(0,0,0,0.08), 0 60px 120px -20px rgba(0,0,0,0.07)',
        display: 'flex',
        flexDirection: 'column',
        ...style,
      }}
    >
      <div
        style={{
          height: 36,
          flexShrink: 0,
          background: surface.chromeBg,
          borderBottom: `1px solid ${surface.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 14px',
        }}
      >
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#FF5F56' }} />
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#FFBD2E' }} />
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#27C93F' }} />
        <div
          style={{
            flex: 1,
            marginLeft: 16,
            padding: '4px 12px',
            borderRadius: 6,
            background: surface.urlBg,
            border: `1px solid ${surface.border}`,
            color: surface.chromeFg,
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          }}
        >
          {url ?? 'app.example.com'}
        </div>
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

interface PillProps {
  /** Pill label text. */
  children: React.ReactNode
  /** Color treatment. accent uses branding.accentColor — the Pill takes
   *  branding via props since the LLM passes it. */
  tone?: 'success' | 'warning' | 'danger' | 'accent' | 'muted'
  /** Optional dot prefix — set true to show a colored dot before the label. */
  dot?: boolean
  /** When tone='accent', passes branding.accentColor through. */
  accentColor?: string
  style?: React.CSSProperties
}

/**
 * Status / label pill. Styling matches the reference MCPMock "connected"
 * indicator — rounded-full, tone-aware bg + fg, optional dot.
 */
export const Pill: React.FC<PillProps> = ({ children, tone = 'success', dot = false, accentColor = '#9755CE', style }) => {
  const colors = {
    success: { fg: '#22C55E', bg: '#22C55E25' },
    warning: { fg: '#F59E0B', bg: '#F59E0B25' },
    danger:  { fg: '#EF4444', bg: '#EF444425' },
    muted:   { fg: '#71717A', bg: '#71717A20' },
    accent:  { fg: accentColor, bg: `${accentColor}25` },
  }[tone]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        background: colors.bg,
        color: colors.fg,
        fontSize: 11,
        fontWeight: 700,
        ...style,
      }}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: colors.fg }} />}
      {children}
    </span>
  )
}

interface AccentGlowProps {
  /** Brand color — pass branding.accentColor. */
  color: string
  /** Width/height in px. Defaults to 540. */
  size?: number
  /** Static opacity, or omit and the glow pulses automatically. */
  opacity?: number
  /** Frame override — when omitted the glow stays static. Pass
   *  Remotion.useCurrentFrame() to enable the breathing pulse. */
  frame?: number
  /** Where the glow sits within its parent. Defaults to dead center. */
  position?: 'center' | 'top' | 'bottom' | 'left' | 'right'
  style?: React.CSSProperties
}

/** Cinematic accent-color blur backdrop. Place behind the focal element
 *  for instant depth. Pulses subtly when given a frame. */
export const AccentGlow: React.FC<AccentGlowProps> = ({ color, size = 540, opacity, frame, position = 'center', style }) => {
  const pulse = frame !== undefined ? 0.30 + 0.15 * Math.sin(frame / 14) : (opacity ?? 0.4)
  const positions: Record<NonNullable<AccentGlowProps['position']>, React.CSSProperties> = {
    center: { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' },
    top:    { left: '50%', top: 0,     transform: 'translate(-50%, -50%)' },
    bottom: { left: '50%', bottom: 0,  transform: 'translate(-50%, 50%)' },
    left:   { left: 0,     top: '50%', transform: 'translate(-50%, -50%)' },
    right:  { right: 0,    top: '50%', transform: 'translate(50%, -50%)' },
  }
  return (
    <div
      style={{
        position: 'absolute',
        ...positions[position],
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        filter: `blur(${Math.round(size * 0.25)}px)`,
        opacity: pulse,
        pointerEvents: 'none',
        ...style,
      }}
    />
  )
}

interface AnimatedCursorProps {
  /** Where the cursor sits, in % of parent (0-100). Use the SAME
   *  coordinates as your target element's center for pixel-perfect
   *  alignment. */
  leftPct: number
  topPct: number
  /** Whether to draw a click-ripple at the position. Pair with a
   *  click-window using your scene's frame counter. */
  ripple?: boolean
  /** Ripple radius in px. Animate from 0 → ~80 over the click window. */
  rippleRadius?: number
  /** Ripple opacity. Animate from 0.5 → 0 over the click window. */
  rippleOpacity?: number
  /** Brand color for the ripple stroke. */
  accentColor: string
}

/** Animated-cursor + optional click-ripple primitive. The LLM positions
 *  it in % coordinates; same numbers as a flex-centered target → cursor
 *  lands ON the target every time, no manual pixel math. */
export const AnimatedCursor: React.FC<AnimatedCursorProps> = ({ leftPct, topPct, ripple, rippleRadius = 0, rippleOpacity = 0, accentColor }) => {
  return (
    <>
      {ripple && (
        <div
          style={{
            position: 'absolute',
            left: `${leftPct}%`,
            top: `${topPct}%`,
            transform: 'translate(-50%, -50%)',
            width: rippleRadius * 2,
            height: rippleRadius * 2,
            borderRadius: '50%',
            border: `3px solid ${accentColor}`,
            opacity: rippleOpacity,
            pointerEvents: 'none',
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          left: `${leftPct}%`,
          top: `${topPct}%`,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.30))',
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24">
          <path d="M3 2l8 18 2-8 8-2z" fill="#FFFFFF" stroke="#000000" strokeWidth="1.4" />
        </svg>
      </div>
    </>
  )
}

/** Wrap a lucide icon so it defaults to a thin (1.5px) stroke — the
 *  default 2px stroke reads as "Bootstrap admin 2018"; 1.5px is the
 *  Linear / Vercel / Arc weight. The LLM can override per-call by
 *  passing a different `strokeWidth` prop. */
function thin(Icon: LucideIcon): React.FC<React.ComponentProps<LucideIcon>> {
  const Wrapped: React.FC<React.ComponentProps<LucideIcon>> = (props) => (
    <Icon strokeWidth={1.5} {...props} />
  )
  Wrapped.displayName = `Thin(${Icon.displayName ?? 'Icon'})`
  return Wrapped
}

/** Every lucide-react icon, lazily wrapped with a thin 1.5px stroke
 *  the first time the LLM accesses it. We expose the full lucide
 *  catalog (~1500 icons) so the model isn't forced to pick from a
 *  curated subset — restricting creativity for marketing visuals
 *  was producing more failures (icon-not-found → blank render) than
 *  the curation was worth.
 *
 *  Aliases preserved for the LLM's natural vocabulary:
 *    Message → MessageSquare, Volume → Volume2, BarChart →
 *    BarChart2, Trash → Trash2, Share → Share2, Image → ImageIcon.
 */
const wrapped = new Map<string, React.FC<React.ComponentProps<LucideIcon>>>()
const ALIASES: Record<string, string> = {
  Message: 'MessageSquare',
  Volume: 'Volume2',
  BarChart: 'BarChart2',
  Trash: 'Trash2',
  Share: 'Share2',
}
function resolveLucideIcon(name: string): LucideIcon | null {
  const all = LucideIcons as unknown as Record<string, unknown>
  const aliased = ALIASES[name]
  const candidate = (aliased && all[aliased]) ?? all[name]
  if (typeof candidate !== 'function' && typeof candidate !== 'object') return null
  // lucide-react exports a forwardRef wrapper (object with $$typeof) — both
  // function and object are valid React components.
  return candidate as LucideIcon
}
export const Icons = new Proxy({} as Record<string, React.FC<React.ComponentProps<LucideIcon>>>, {
  get(_target, prop) {
    if (typeof prop !== 'string') return undefined
    const cached = wrapped.get(prop)
    if (cached) return cached
    const Icon = resolveLucideIcon(prop)
    if (!Icon) return undefined
    const Wrapped = thin(Icon)
    wrapped.set(prop, Wrapped)
    return Wrapped
  },
}) as Record<string, React.FC<React.ComponentProps<LucideIcon>>>

/** Recharts components exposed for the LLM. Animations driven by
 *  Remotion frame, not Recharts' internal tweening — the LLM passes
 *  data computed via interpolate() so the chart "draws in" frame by
 *  frame. Use ResponsiveContainer + LineChart / AreaChart / BarChart /
 *  PieChart inside a fixed-size parent (a card body, etc.) */
export const Charts = {
  ResponsiveContainer,
  LineChart, Line,
  AreaChart, Area,
  BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell,
} as const

/** Type for the helpers bundled into the LLM's `Remotion` namespace. */
export interface MockHelpers {
  MockFrame: typeof MockFrame
  Pill: typeof Pill
  AccentGlow: typeof AccentGlow
  AnimatedCursor: typeof AnimatedCursor
  Icons: typeof Icons
}

/** Convenience dummy referencing Branding so the type import isn't
 *  flagged as unused. Branding is documented in the public type — the
 *  LLM mock receives it via props, not via this helper module. */
export type _BrandingRef = Branding
