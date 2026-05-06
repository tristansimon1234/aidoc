import React from 'react'
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Img,
  Audio,
} from 'remotion'
import type { Branding } from '../manifest.js'
import { MockFrame, Pill, AccentGlow, AnimatedCursor, Icons, Charts } from './mock-helpers.js'
import {
  TypewriterText,
  FadeInStagger,
  PulseGlow,
  BreathingScale,
  OrbitingDot,
  Connector,
  TravelingPhoton,
  ParticleField,
} from './animation-primitives.js'

interface DynamicSceneProps {
  /** esbuild-compiled JS that defines a function/const named MockScene.
   *  We append `;return MockScene` and instantiate via `new Function`,
   *  so the LLM-written TSX runs without imports — React + Remotion +
   *  branding are passed in as parameters. */
  mockCompiledCode: string
  branding: Branding
}

/**
 * Evaluates LLM-generated TSX (compiled to JS server-side) and renders
 * the resulting component.
 *
 * The compiled code references three globals that don't exist in the
 * bundle: React, Remotion, branding. We bind them as `new Function`
 * arguments so the code runs in a leak-tight scope without polluting
 * the bundle's globals. The LLM is told (in the prompt) which Remotion
 * symbols are available; we just wire them through.
 *
 * Errors during compilation are caught upstream (mock-code.compiler
 * throws if TSX won't transform). Errors during EVALUATION (the
 * compiled code throws at render time) fall through to the React
 * error boundary in <SafeMockBoundary> below — the scene shows a
 * minimal "scene unavailable" placeholder rather than crashing the
 * whole render.
 */
export const DynamicScene: React.FC<DynamicSceneProps> = ({ mockCompiledCode, branding }) => {
  return (
    <SafeMockBoundary fallback={<SceneFallback branding={branding} />}>
      <DynamicSceneInner mockCompiledCode={mockCompiledCode} branding={branding} />
    </SafeMockBoundary>
  )
}

const DynamicSceneInner: React.FC<DynamicSceneProps> = ({ mockCompiledCode, branding }) => {
  // Build the component once per (compiledCode) — instantiating Function
  // is the expensive bit. React.useMemo keeps it stable across frames.
  const MockScene = React.useMemo<React.FC<{ branding: Branding }>>(() => {
    // Wrap Icons in a Proxy so unknown lookups (Icons[someVarName] where
    // the LLM picked an icon name not in our whitelist) return a default
    // square placeholder instead of undefined. Rendering <undefined> in
    // JSX position throws and trips the error boundary; rendering a
    // generic icon keeps the scene alive and visible.
    const FallbackIcon: React.FC<{ size?: number; color?: string }> = ({ size = 24, color = 'currentColor' }) =>
      React.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
        React.createElement('rect', {
          x: 4, y: 4, width: 16, height: 16, rx: 3,
          stroke: color, strokeWidth: 1.5,
        }),
      )
    const safeIcons = new Proxy(Icons as unknown as Record<string, React.FC<{ size?: number; color?: string }>>, {
      get(target, prop) {
        if (typeof prop !== 'string') return undefined
        return target[prop] ?? FallbackIcon
      },
    })

    const Remotion = {
      interpolate, spring, useCurrentFrame, useVideoConfig, AbsoluteFill, Img, Audio,
      // Designed helpers — let the LLM stop rewriting the same browser
      // chrome / pill / glow / cursor every scene. MockFrame is now
      // OPTIONAL (per-scene; the architect picks the cadrage); the
      // others are pure utilities the LLM can compose freely.
      MockFrame, Pill, AccentGlow, AnimatedCursor,
      Icons: safeIcons,
      // Recharts components for data scenes — line / area / bar / pie.
      Charts,
      // Animation primitives — pure-logic helpers (timing, easing,
      // particle math). They impose no visual identity, only behavior,
      // so they don't converge videos to the same look.
      TypewriterText,
      FadeInStagger,
      PulseGlow,
      BreathingScale,
      OrbitingDot,
      Connector,
      TravelingPhoton,
      ParticleField,
    }
    // The LLM is asked to define a function named MockScene. We append
    // `;return MockScene` to expose it to the caller.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
      'React',
      'Remotion',
      `${mockCompiledCode};\nreturn typeof MockScene === 'function' ? MockScene : null;`,
    )
    const Component = factory(React, Remotion) as React.FC<{ branding: Branding }> | null
    if (!Component) {
      throw new Error('Compiled mockCode did not export a MockScene function')
    }
    return Component
  }, [mockCompiledCode])

  // The mock provides its own browser-frame chrome (per the prompt's
  // strict requirement). We just need a positioned container that
  // clips any LLM overflow at the panel boundary.
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <MockScene branding={branding} />
    </div>
  )
}

interface BoundaryState { error: Error | null }

class SafeMockBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: null }
  static getDerivedStateFromError(error: Error): BoundaryState { return { error } }
  componentDidCatch(error: Error): void {
    // Remotion's headless Chrome surfaces uncaught errors as render
    // failures. Catching here keeps the rest of the video alive.
    console.warn('[DynamicScene] mock evaluation failed:', error.message)
  }
  render(): React.ReactNode {
    if (this.state.error) return this.props.fallback
    return this.props.children
  }
}

const SceneFallback: React.FC<{ branding: Branding }> = ({ branding }) => {
  // Used when the LLM mock throws at render time (uncaught exception
  // inside the new Function() factory or its return value). We match
  // the canvas bgColor so the failure is invisible — the headline +
  // brand mark from the surrounding FeatureScene still carry the scene.
  return <AbsoluteFill style={{ background: branding.bgColor }} />
}
