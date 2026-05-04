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

// Whitelists derived from what's actually exposed in the Remotion bundle
// (remotion/src/scenes/DynamicScene.tsx). When the LLM accesses something
// not on these lists the call resolves to `undefined` at runtime and
// either renders nothing or throws — both end up as the gradient
// fallback. We catch those references statically here so the rescue
// retry path can ask Gemini to fix them.
const BRANDING_FIELDS = new Set([
  'productName', 'accentColor', 'bgColor', 'textColor', 'fontFamily',
])

const REMOTION_NAMESPACE = new Set([
  // Core Remotion exports
  'interpolate', 'spring', 'useCurrentFrame', 'useVideoConfig',
  'AbsoluteFill', 'Img', 'Audio',
  // Helpers + namespaces
  'MockFrame', 'Pill', 'AccentGlow', 'AnimatedCursor', 'Icons', 'Charts',
])

const ICON_NAMES = new Set([
  'Plug', 'Mic', 'Check', 'Message', 'MessageSquare', 'Search', 'Zap',
  'Code', 'Settings', 'MousePointer', 'Send', 'Loader', 'Bell', 'User',
  'Lock', 'Globe', 'ChevronRight', 'Plus', 'X', 'Copy', 'Play', 'Pause',
  'Volume', 'Volume2', 'Image', 'ArrowRight', 'ArrowUpRight', 'Activity',
  'Cpu', 'Layers', 'Database', 'GitBranch', 'FileText', 'Cloud',
  'Workflow', 'Boxes',
  'BarChart', 'BarChart2', 'BarChart3', 'TrendingUp', 'TrendingDown',
  'Star', 'Heart',
  'Video', 'BookOpen', 'Users', 'Mail', 'Calendar', 'Tag', 'Filter',
  'Bookmark', 'Camera', 'Clock', 'Edit', 'Trash', 'Trash2', 'Save',
  'Upload', 'Download', 'Share', 'Share2', 'Eye', 'Sparkles', 'Rocket',
  'Target', 'Award', 'Briefcase', 'ShoppingCart', 'Home', 'Folder',
  'File', 'Inbox', 'Hash', 'AtSign', 'ExternalLink',
])

const CHART_NAMES = new Set([
  'ResponsiveContainer', 'LineChart', 'Line', 'AreaChart', 'Area',
  'BarChart', 'Bar', 'XAxis', 'YAxis', 'CartesianGrid', 'Tooltip',
  'PieChart', 'Pie', 'Cell',
])

/**
 * Static lint that catches the most common runtime failures the LLM
 * introduces: referencing properties that don't exist in the runtime
 * scope. Without this check, the code compiles fine, then throws inside
 * Remotion's headless Chrome on first render, and every scene shows the
 * accent-gradient fallback. By rejecting at compile time we route these
 * cases through the existing per-scene rescue retry.
 */
function lintRuntimeReferences(source: string): string | null {
  const errors: string[] = []

  const brandingRefs = source.matchAll(/\bbranding\s*\.\s*([A-Za-z_$][\w$]*)/g)
  for (const m of brandingRefs) {
    const field = m[1]!
    if (!BRANDING_FIELDS.has(field)) {
      errors.push(`branding.${field} does not exist (allowed: ${[...BRANDING_FIELDS].join(', ')})`)
    }
  }

  const remotionRefs = source.matchAll(/\bRemotion\s*\.\s*([A-Za-z_$][\w$]*)/g)
  for (const m of remotionRefs) {
    const sym = m[1]!
    if (!REMOTION_NAMESPACE.has(sym)) {
      errors.push(`Remotion.${sym} does not exist (allowed: ${[...REMOTION_NAMESPACE].join(', ')})`)
    }
  }

  const iconRefs = source.matchAll(/\bRemotion\.Icons\s*\.\s*([A-Za-z_$][\w$]*)/g)
  for (const m of iconRefs) {
    const name = m[1]!
    if (!ICON_NAMES.has(name)) {
      errors.push(`Remotion.Icons.${name} does not exist (allowed: ${[...ICON_NAMES].join(', ')})`)
    }
  }

  const chartRefs = source.matchAll(/\bRemotion\.Charts\s*\.\s*([A-Za-z_$][\w$]*)/g)
  for (const m of chartRefs) {
    const name = m[1]!
    if (!CHART_NAMES.has(name)) {
      errors.push(`Remotion.Charts.${name} does not exist (allowed: ${[...CHART_NAMES].join(', ')})`)
    }
  }

  // Dedup — the LLM tends to repeat the same wrong reference 3-4 times.
  const unique = [...new Set(errors)]
  return unique.length > 0 ? unique.join('; ') : null
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
 *  - references properties that don't exist on branding / Remotion /
 *    Icons / Charts (those would compile but throw at render time)
 *
 * After compile, the returned code is a sequence of statements;
 * appending `;return MockScene` to it gives a one-liner Function body
 * that exposes the component.
 */
export async function compileMockCode(source: string): Promise<CompiledMock> {
  const trimmed = source.trim()
  if (trimmed.length === 0) throw new Error('mockCode is empty')
  if (trimmed.length > 6_000) throw new Error(`mockCode too large (${trimmed.length} bytes, cap 6_000)`)

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

  const lintError = lintRuntimeReferences(trimmed)
  if (lintError) {
    throw new Error(`mockCode references unknown runtime symbols: ${lintError}`)
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
