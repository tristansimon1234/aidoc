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
    const Remotion = { interpolate, spring, useCurrentFrame, useVideoConfig, AbsoluteFill, Img, Audio }
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

  // No card chrome. Each LLM mock is responsible for its own full-bleed
  // background (the prompt explicitly asks for it). Wrapping in a card
  // here painted a useless border around the mock.
  return <MockScene branding={branding} />
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
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${branding.accentColor}55, #0B0B0F)`,
      }}
    />
  )
}
