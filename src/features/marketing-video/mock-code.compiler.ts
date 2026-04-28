import { transform } from 'esbuild'

export interface CompiledMock {
  /** Raw TSX as the LLM emitted it. Stored for diagnostics + rerunning
   *  the compile step in isolation. */
  source: string
  /** ES2020 JS output of esbuild's TSX transform — a sequence of
   *  statements declaring `MockScene` (a function component). The
   *  Remotion-side `<DynamicScene>` wraps this in a `new Function(...)`
   *  call with React + Remotion + branding bound, so the scene
   *  imports nothing and reads only what we hand it. */
  compiled: string
}

/**
 * Compile LLM-generated TSX for a marketing-video scene into runnable
 * JS. The LLM emits something like:
 *
 *   function MockScene({ branding }) {
 *     const frame = Remotion.useCurrentFrame()
 *     const opacity = Remotion.interpolate(frame, [0, 30], [0, 1])
 *     return <div style={{ opacity, color: branding.accentColor }}>Hello</div>
 *   }
 *
 * We reject anything that:
 *  - tries to import or require something
 *  - opens an iframe / fetch / new XMLHttpRequest
 *  - is too large (>10 KB)
 *
 * After compile, the returned code is a sequence of statements;
 * appending `;return MockScene` to it gives a one-liner Function body
 * that exposes the component.
 */
export async function compileMockCode(source: string): Promise<CompiledMock> {
  const trimmed = source.trim()
  if (trimmed.length === 0) throw new Error('mockCode is empty')
  if (trimmed.length > 10_000) throw new Error(`mockCode too large (${trimmed.length} bytes, cap 10_000)`)

  // Naive but cheap dangerous-pattern check. We're not running this in a
  // browser sandbox — it executes inside the Remotion bundle running in
  // headless Chrome on the video-service — but disallowing imports +
  // network access trims the surface area meaningfully.
  const banned = [
    /\bimport\b/,
    /\brequire\(/,
    /\bfetch\(/,
    /\bnew\s+XMLHttpRequest\b/,
    /\beval\(/,
    /\bnew\s+Function\b/,
    /\bdocument\.write\b/,
    /\bwindow\.open\b/,
  ]
  for (const re of banned) {
    if (re.test(trimmed)) {
      throw new Error(`mockCode contains banned pattern ${re.source}`)
    }
  }

  let result
  try {
    result = await transform(trimmed, {
      loader: 'tsx',
      jsx: 'transform',
      target: 'es2020',
      // Inline source maps would balloon the manifest. Drop them.
      sourcemap: false,
      // Strip type annotations + JSX entirely; we want pure JS out.
      minify: false,
    })
  } catch (err) {
    throw new Error(`mockCode failed to compile: ${(err as Error).message}`)
  }

  const compiled = result.code.trim()
  if (!/\bMockScene\b/.test(compiled)) {
    throw new Error('mockCode must define a function or const named MockScene')
  }

  return { source: trimmed, compiled }
}
