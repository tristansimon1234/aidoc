import React from 'react'
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  interpolateColors,
  random,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion'
import type { Brand, SceneProps } from './props.js'
import {
  AccentGlow,
  AnimatedCursor,
  Charts,
  Icons,
  MockFrame,
  Pill,
  Screenshot,
} from './toolkit/helpers.js'
import {
  BreathingScale,
  Connector,
  FadeInStagger,
  OrbitingDot,
  ParticleField,
  PulseGlow,
  TravelingPhoton,
  TypewriterText,
} from './toolkit/primitives.js'
import { FallbackScene } from './FallbackScene.js'

type SceneComponent = React.FC<{
  brand: Brand
  shots: SceneProps['shots']
  durationInFrames: number
}>

/** Icône de secours quand le nom demandé n'existe pas (au lieu d'un crash). */
const FallbackIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 24,
  color = 'currentColor',
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x={4} y={4} width={16} height={16} rx={3} stroke={color} strokeWidth={1.5} />
  </svg>
)

const safeIcons = new Proxy(Icons, {
  get(target, prop) {
    if (typeof prop !== 'string') return undefined
    return target[prop] ?? FallbackIcon
  },
})

/** Ce que le code d'une scène peut utiliser (voir la doc dans server/pipeline/prompts.ts). */
const RemotionApi = {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  interpolateColors,
  random,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Screenshot,
  MockFrame,
  Pill,
  AccentGlow,
  AnimatedCursor,
  Icons: safeIcons,
  Charts,
  TypewriterText,
  FadeInStagger,
  PulseGlow,
  BreathingScale,
  OrbitingDot,
  Connector,
  TravelingPhoton,
  ParticleField,
}

function instantiate(code: string): SceneComponent {
  // Le code (compilé côté serveur) définit `Scene` ; React et Remotion lui sont passés en paramètres.
  const factory = new Function(
    'React',
    'Remotion',
    `${code};\nreturn typeof Scene === 'function' ? Scene : null;`,
  ) as (react: typeof React, remotion: typeof RemotionApi) => SceneComponent | null
  const Component = factory(React, RemotionApi)
  if (!Component) throw new Error('The code does not define a function named Scene')
  return Component
}

/**
 * Scène écrite par l'IA. En rendu final, une erreur affiche la scène de secours au lieu de casser
 * toute la vidéo ; en `strict` (test de la scène), l'erreur remonte pour être renvoyée à l'IA.
 */
export const DynamicScene: React.FC<{ scene: SceneProps; brand: Brand; strict: boolean }> = ({
  scene,
  brand,
  strict,
}) => {
  const fallback = <FallbackScene scene={scene} brand={brand} />
  if (!scene.code) return fallback
  const inner = <SceneRunner scene={scene} brand={brand} code={scene.code} />
  return strict ? inner : <Boundary fallback={fallback}>{inner}</Boundary>
}

const SceneRunner: React.FC<{ scene: SceneProps; brand: Brand; code: string }> = ({
  scene,
  brand,
  code,
}) => {
  const Scene = React.useMemo(() => instantiate(code), [code])
  return (
    <AbsoluteFill style={{ background: brand.background, overflow: 'hidden' }}>
      <Scene brand={brand} shots={scene.shots} durationInFrames={scene.durationInFrames} />
    </AbsoluteFill>
  )
}

class Boundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error) {
    console.warn('[DynamicScene] scène remplacée par la scène de secours :', error.message)
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
