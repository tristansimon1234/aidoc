import React from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'

/**
 * Animation primitives exposed to LLM-generated mock code via the
 * `Remotion` namespace. These encapsulate non-trivial timing / easing
 * math (typewriter character pacing, particle field drift, traveling
 * dots, orbital motion) — the LLM consistently re-implemented these
 * badly when forced to write them inline.
 *
 * **Design principle.** These primitives carry only LOGIC, never a
 * visual identity. They take colors / sizes / radii from props (which
 * the LLM passes from `branding.*`), so a TypewriterText looks like
 * the rest of the scene. We deliberately did NOT add UI archetypes
 * (BrowserMock / ChatBubble / TerminalWindow / …) — those would lock
 * every scene to the same look and kill creative variety.
 *
 * All primitives:
 *  - read frame state via `useCurrentFrame()` / `useVideoConfig()`
 *    internally; the caller doesn't manage timing math.
 *  - have safe defaults for every optional prop, so a one-liner
 *    invocation produces something usable.
 *  - never set a background color — they paint INSIDE whatever the
 *    caller positions them in.
 */

// ----- TypewriterText ------------------------------------------------------

interface TypewriterTextProps {
  /** Full string to type out. */
  text: string
  /** Frame at which the first character appears. Default 0. */
  startFrame?: number
  /** Characters revealed per frame (at 30fps, 0.6 = ~18 chars/sec).
   *  Default 0.6. Higher = faster typing. */
  charsPerFrame?: number
  /** Show a blinking caret at the end of the typed text. Default true. */
  cursor?: boolean
  /** Caret color. Default 'currentColor' (inherits from parent text color). */
  cursorColor?: string
  /** Inline style merged into the wrapper span. Use for font / color /
   *  size — typography is the caller's responsibility. */
  style?: React.CSSProperties
  className?: string
}

/**
 * Type-on text that reveals one character at a time.
 *
 * @example
 * <span style={{ fontSize: 36, color: branding.accentColor }}>
 *   <Remotion.TypewriterText text="hello world" startFrame={10} />
 * </span>
 */
export const TypewriterText: React.FC<TypewriterTextProps> = ({
  text,
  startFrame = 0,
  charsPerFrame = 0.6,
  cursor = true,
  cursorColor = 'currentColor',
  style,
  className,
}) => {
  const frame = useCurrentFrame()
  const elapsed = Math.max(0, frame - startFrame)
  const charsShown = Math.min(text.length, Math.floor(elapsed * charsPerFrame))
  const blink = (frame % 30) < 15 ? 1 : 0
  return (
    <span style={style} className={className}>
      {text.slice(0, charsShown)}
      {cursor && (
        <span
          style={{
            display: 'inline-block',
            width: 2,
            height: '0.95em',
            marginLeft: 2,
            verticalAlign: 'baseline',
            background: cursorColor,
            opacity: blink,
          }}
        />
      )}
    </span>
  )
}

// ----- FadeInStagger -------------------------------------------------------

interface FadeInStaggerProps {
  /** Frame at which the first child fades in. Default 0. */
  startFrame?: number
  /** Frames between each child's fade-in. Default 6 (~0.2s at 30fps). */
  stagger?: number
  /** Frames over which each child's opacity ramps 0 → 1. Default 12
   *  (the floor we recommend in the prompt — anything shorter snaps). */
  fadeFrames?: number
  /** Vertical offset (px) that each child slides in from. Default 8. */
  slideY?: number
  children: React.ReactNode
  /** Wrapping element. Default 'div'. */
  as?: 'div' | 'span'
  /** Style applied to the wrapper. Children-side spacing is the caller's job. */
  style?: React.CSSProperties
  className?: string
}

/**
 * Fade + slide-in cascade for direct children. Each child is wrapped
 * in a span/div that animates `opacity` and `transform: translateY`.
 *
 * @example
 * <Remotion.FadeInStagger startFrame={6} stagger={8}>
 *   <div>First</div>
 *   <div>Second</div>
 *   <div>Third</div>
 * </Remotion.FadeInStagger>
 */
export const FadeInStagger: React.FC<FadeInStaggerProps> = ({
  startFrame = 0,
  stagger = 6,
  fadeFrames = 12,
  slideY = 8,
  children,
  as = 'div',
  style,
  className,
}) => {
  const frame = useCurrentFrame()
  const Wrapper = as
  const items = React.Children.toArray(children)
  return (
    <Wrapper style={style} className={className}>
      {items.map((child, i) => {
        const childStart = startFrame + i * stagger
        const t = interpolate(frame, [childStart, childStart + fadeFrames], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
        return (
          <div
            key={i}
            style={{
              opacity: t,
              transform: `translateY(${(1 - t) * slideY}px)`,
            }}
          >
            {child}
          </div>
        )
      })}
    </Wrapper>
  )
}

// ----- PulseGlow -----------------------------------------------------------

interface PulseGlowProps {
  /** Glow color. Default 'currentColor' — caller passes branding.accentColor. */
  color?: string
  /** Peak glow blur radius in px. Default 32. */
  intensity?: number
  /** Frames per oscillation cycle. Default 42 (~1.4s at 30fps). */
  period?: number
  /** Children get the pulsing boxShadow. */
  children: React.ReactNode
  /** Inline style merged with the computed shadow. */
  style?: React.CSSProperties
  className?: string
}

/**
 * Wraps children in a div whose `boxShadow` blur radius pulses on a
 * sine wave. Use sparingly — at most one pulsing element per scene.
 *
 * @example
 * <Remotion.PulseGlow color={branding.accentColor} intensity={48}>
 *   <div className='rounded-2xl bg-white p-6'>focal card</div>
 * </Remotion.PulseGlow>
 */
export const PulseGlow: React.FC<PulseGlowProps> = ({
  color = 'currentColor',
  intensity = 32,
  period = 42,
  children,
  style,
  className,
}) => {
  const frame = useCurrentFrame()
  const t = (Math.sin((frame / period) * Math.PI * 2) + 1) / 2
  const blur = intensity * 0.5 + intensity * 0.5 * t
  const opacity = 0.55 + 0.35 * t
  // The 4-channel hex (color + alpha) trick keeps the shadow fading
  // smoothly instead of stepping when the caller passes a 6-digit hex.
  return (
    <div
      style={{
        boxShadow: `0 0 ${blur}px ${color}${alphaHex(opacity)}`,
        ...style,
      }}
      className={className}
    >
      {children}
    </div>
  )
}

// ----- BreathingScale ------------------------------------------------------

interface BreathingScaleProps {
  /** Peak scale offset (1 = no scale, 1.04 = 4% breath). Default 0.02. */
  amplitude?: number
  /** Frames per cycle. Default 64 (~2.1s — slow ambient breath). */
  period?: number
  children: React.ReactNode
  style?: React.CSSProperties
  className?: string
}

/**
 * Subtle sinusoidal scale on the wrapper. Makes a focal element feel
 * "alive" without distracting motion.
 *
 * @example
 * <Remotion.BreathingScale amplitude={0.03}>
 *   <div className='text-[120px] font-black'>92%</div>
 * </Remotion.BreathingScale>
 */
export const BreathingScale: React.FC<BreathingScaleProps> = ({
  amplitude = 0.02,
  period = 64,
  children,
  style,
  className,
}) => {
  const frame = useCurrentFrame()
  const scale = 1 + amplitude * Math.sin((frame / period) * Math.PI * 2)
  return (
    <div
      style={{
        transform: `scale(${scale})`,
        ...style,
      }}
      className={className}
    >
      {children}
    </div>
  )
}

// ----- OrbitingDot ---------------------------------------------------------

interface OrbitingDotProps {
  /** Center coordinates as % of parent (0-100). Default { x: 50, y: 50 }. */
  center?: { x: number; y: number }
  /** Orbit radius in px. Default 64. */
  radius?: number
  /** Frames per full orbit. Default 90 (~3s). */
  period?: number
  /** Phase offset in radians (use to stagger multiple dots on same center). */
  phase?: number
  /** Dot diameter in px. Default 8. */
  size?: number
  /** Dot color. Default 'currentColor'. */
  color?: string
}

/**
 * A small dot that orbits around a point inside its absolutely-positioned
 * parent. Caller is responsible for `position: relative` on the parent.
 *
 * @example
 * <div style={{ position: 'relative', width: 240, height: 240 }}>
 *   <Remotion.OrbitingDot radius={80} period={90} color={branding.accentColor} />
 *   <Remotion.OrbitingDot radius={80} period={90} phase={Math.PI} color={branding.accentColor} />
 * </div>
 */
export const OrbitingDot: React.FC<OrbitingDotProps> = ({
  center = { x: 50, y: 50 },
  radius = 64,
  period = 90,
  phase = 0,
  size = 8,
  color = 'currentColor',
}) => {
  const frame = useCurrentFrame()
  const angle = (frame / period) * Math.PI * 2 + phase
  const dx = Math.cos(angle) * radius
  const dy = Math.sin(angle) * radius
  return (
    <div
      style={{
        position: 'absolute',
        left: `${center.x}%`,
        top: `${center.y}%`,
        width: size,
        height: size,
        marginLeft: -size / 2 + dx,
        marginTop: -size / 2 + dy,
        borderRadius: '50%',
        background: color,
        boxShadow: `0 0 ${size * 1.5}px ${color}`,
      }}
    />
  )
}

// ----- Connector -----------------------------------------------------------

interface ConnectorProps {
  /** Start point as % of parent (0-100). */
  from: { x: number; y: number }
  /** End point as % of parent (0-100). */
  to: { x: number; y: number }
  /** Line color. Default 'currentColor'. */
  color?: string
  /** Line opacity. Default 0.3 (subtle). */
  opacity?: number
  /** Line thickness in px. Default 2. */
  thickness?: number
  /** Frame at which the line draws in (left → right). Default 0. */
  startFrame?: number
  /** Frames over which the line draws. Default 18 (~0.6s). */
  drawFrames?: number
  /** Show a traveling photon sliding along the line continuously. Default false. */
  traveling?: boolean
  /** Period (frames) for one traveling-photon traversal. Default 48. */
  travelingPeriod?: number
}

/**
 * Animated line between two points (% coordinates) that draws in then
 * optionally has a photon sliding along it on a loop.
 *
 * Caller is responsible for `position: relative` on the parent.
 *
 * @example
 * <div style={{ position: 'relative', width: 400, height: 200 }}>
 *   <NodeA /><NodeB />
 *   <Remotion.Connector from={{x:10,y:50}} to={{x:90,y:50}} traveling color={branding.accentColor} />
 * </div>
 */
export const Connector: React.FC<ConnectorProps> = ({
  from,
  to,
  color = 'currentColor',
  opacity = 0.3,
  thickness = 2,
  startFrame = 0,
  drawFrames = 18,
  traveling = false,
  travelingPeriod = 48,
}) => {
  const frame = useCurrentFrame()
  const drawT = interpolate(frame, [startFrame, startFrame + drawFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  const dxPct = to.x - from.x
  const dyPct = to.y - from.y
  // Pixel length is approximated from % at render scale via a scale-invariant
  // proxy — the actual length is computed by the SVG viewBox below.
  const photonT = ((frame - startFrame - drawFrames) / travelingPeriod) % 1
  const photonValid = traveling && frame >= startFrame + drawFrames
  const px = from.x + dxPct * (photonValid ? Math.max(0, photonT) : 0)
  const py = from.y + dyPct * (photonValid ? Math.max(0, photonT) : 0)
  return (
    <>
      <svg
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          overflow: 'visible',
        }}
      >
        <line
          x1={`${from.x}%`}
          y1={`${from.y}%`}
          x2={`${from.x + dxPct * drawT}%`}
          y2={`${from.y + dyPct * drawT}%`}
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap='round'
          opacity={opacity}
        />
      </svg>
      {photonValid && (
        <div
          style={{
            position: 'absolute',
            left: `${px}%`,
            top: `${py}%`,
            width: thickness * 3,
            height: thickness * 3,
            marginLeft: -(thickness * 3) / 2,
            marginTop: -(thickness * 3) / 2,
            borderRadius: '50%',
            background: color,
            boxShadow: `0 0 ${thickness * 6}px ${color}`,
            pointerEvents: 'none',
          }}
        />
      )}
    </>
  )
}

// ----- TravelingPhoton -----------------------------------------------------

interface TravelingPhotonProps {
  /** Start point as % of parent (0-100). */
  from: { x: number; y: number }
  /** End point as % of parent (0-100). */
  to: { x: number; y: number }
  /** Frames per traversal. Default 60 (~2s). */
  speed?: number
  /** Photon diameter in px. Default 10. */
  size?: number
  /** Photon color. Default 'currentColor'. */
  color?: string
  /** Add a glow halo. Default true. */
  glow?: boolean
  /** Frame at which to start. Default 0. */
  startFrame?: number
}

/**
 * A point of light that travels from `from` to `to` and loops. Use for
 * data-flow / signal-flow diagrams. Caller's parent must be
 * `position: relative`.
 *
 * @example
 * <Remotion.TravelingPhoton
 *   from={{x:10,y:50}} to={{x:90,y:50}} speed={60} color={branding.accentColor}
 * />
 */
export const TravelingPhoton: React.FC<TravelingPhotonProps> = ({
  from,
  to,
  speed = 60,
  size = 10,
  color = 'currentColor',
  glow = true,
  startFrame = 0,
}) => {
  const frame = useCurrentFrame()
  const elapsed = Math.max(0, frame - startFrame)
  const t = (elapsed % speed) / speed
  const x = from.x + (to.x - from.x) * t
  const y = from.y + (to.y - from.y) * t
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        borderRadius: '50%',
        background: color,
        boxShadow: glow ? `0 0 ${size * 2}px ${color}` : undefined,
        pointerEvents: 'none',
      }}
    />
  )
}

// ----- ParticleField -------------------------------------------------------

interface ParticleFieldProps {
  /** Particle count. Default 24. Cap at ~60 — Chromium rasterization
   *  cost climbs sharply past that. */
  count?: number
  /** Particle color. Default 'currentColor'. */
  color?: string
  /** Particle diameter in px (uniform). Default 3. */
  size?: number
  /** Drift speed in px per frame. Default 0.4. */
  drift?: number
  /** Random seed — same seed produces same layout, useful for
   *  determinism between renders. Default 42. */
  seed?: number
  /** Field opacity. Default 0.5. */
  opacity?: number
}

/**
 * A field of small particles drifting upward on a slow continuous
 * loop. The motion wraps so the field stays full forever. Use as
 * ambient backdrop texture inside a card or behind a focal element.
 * Caller's parent must be `position: relative` and clip overflow.
 *
 * @example
 * <div style={{ position: 'relative', overflow: 'hidden' }}>
 *   <Remotion.ParticleField count={32} color={branding.accentColor} />
 *   <div>focal content</div>
 * </div>
 */
export const ParticleField: React.FC<ParticleFieldProps> = ({
  count = 24,
  color = 'currentColor',
  size = 3,
  drift = 0.4,
  seed = 42,
  opacity = 0.5,
}) => {
  const frame = useCurrentFrame()
  // Deterministic pseudo-random per seed — same particle layout across
  // re-renders. Inline LCG (no need for a full PRNG dep).
  const particles = React.useMemo(() => {
    let s = seed
    const next = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
    return Array.from({ length: count }, () => ({
      x: next() * 100,
      y: next() * 100,
      phase: next() * 100,
      sizeJitter: 0.5 + next(),
    }))
  }, [seed, count])
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        opacity,
        pointerEvents: 'none',
      }}
    >
      {particles.map((p, i) => {
        // Wrap the y-position so particles loop forever instead of
        // drifting off the top. drift is in px-equivalent-as-percent;
        // the field renders at parent size so this stays stable.
        const yWrap = (p.y - frame * drift * 0.1 + p.phase + 1000) % 100
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${p.x}%`,
              top: `${yWrap}%`,
              width: size * p.sizeJitter,
              height: size * p.sizeJitter,
              borderRadius: '50%',
              background: color,
            }}
          />
        )
      })}
    </div>
  )
}

// ----- helpers -------------------------------------------------------------

/** Convert a 0-1 alpha to a two-digit hex pair for `#RRGGBBAA`. */
function alphaHex(opacity: number): string {
  const a = Math.max(0, Math.min(1, opacity))
  const v = Math.round(a * 255)
  return v.toString(16).padStart(2, '0')
}

// Quiet down unused-import lints when this file is imported only for
// the named exports (some bundlers tree-shake aggressively otherwise).
export const __primitives_internal = { spring, useVideoConfig }
