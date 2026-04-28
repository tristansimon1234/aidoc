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
  width?: number
  height?: number
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
export const DynamicScene: React.FC<DynamicSceneProps> = ({ mockCompiledCode, branding, width = 920, height = 580 }) => {
  return (
    <SafeMockBoundary fallback={<SceneFallback branding={branding} width={width} height={height} />}>
      <DynamicSceneInner
        mockCompiledCode={mockCompiledCode}
        branding={branding}
        width={width}
        height={height}
      />
    </SafeMockBoundary>
  )
}

const DynamicSceneInner: React.FC<DynamicSceneProps> = ({ mockCompiledCode, branding, width = 920, height = 580 }) => {
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

  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        borderRadius: 18,
        overflow: 'hidden',
        boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
        background: '#0B0B0F',
        color: '#FFFFFF',
        fontFamily: `${branding.fontFamily}, system-ui, sans-serif`,
      }}
    >
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

const SceneFallback: React.FC<{ branding: Branding; width: number; height: number }> = ({ branding, width, height }) => {
  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        borderRadius: 18,
        overflow: 'hidden',
        background: `linear-gradient(135deg, ${branding.accentColor}55, ${branding.bgColor})`,
        border: `1px solid ${branding.textColor}22`,
      }}
    />
  )
}
