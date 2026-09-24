// Code des scènes écrit par l'IA : extraction de la réponse, contrôles, compilation TSX → JS (esbuild).
import { transform } from 'esbuild'

/** Récupère le code de la réponse du modèle (dernier bloc ```tsx … ```). */
export function extractCode(answer: string): string | null {
  const blocks = [
    ...answer.matchAll(/```(?:tsx|jsx|typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/g),
  ]
  const code = blocks.length > 0 ? blocks[blocks.length - 1]![1]! : answer
  return /\bScene\b/.test(code) ? code.trim() : null
}

/**
 * Ce qui est interdit dans une scène : tout ce qui n'est pas déterministe (le rendu se fait image par
 * image, dans plusieurs onglets) ou qui sort de la scène (réseau, page, stockage).
 */
const FORBIDDEN: [RegExp, string][] = [
  [/^\s*import\s/m, 'No imports: React and Remotion are already in scope.'],
  [/\brequire\s*\(/, 'No require(): React and Remotion are already in scope.'],
  [
    /\bMath\.random\s*\(/,
    'Math.random() flickers between frames: use Remotion.random("seed") instead.',
  ],
  [/\bDate\.now\s*\(|new Date\s*\(/, 'No dates: everything must depend on the frame number only.'],
  [
    /\b(setTimeout|setInterval|requestAnimationFrame)\s*\(/,
    'No timers: animate with the frame number (Remotion.useCurrentFrame()).',
  ],
  [
    /\buse(State|Effect|LayoutEffect|Reducer)\s*\(/,
    'No state or effects: the scene must be a pure function of the frame.',
  ],
  [/\b(fetch|eval)\s*\(|new\s+(XMLHttpRequest|WebSocket)\b/, 'No network or eval.'],
  [
    /\b(window|document|globalThis)\s*\.|\b(localStorage|sessionStorage)\b/,
    'No access to window/document/storage.',
  ],
  [
    /<(video|iframe|audio)\b|Remotion\.(Video|Audio|OffthreadVideo)\b/i,
    'No video/audio/iframe elements: the voice-over is added separately.',
  ],
  [
    /(src\s*=\s*\{?\s*["'`]|url\(\s*["']?)https?:/,
    'No external images or fonts: use the screenshots in `shots`, icons and CSS only.',
  ],
  [
    /@keyframes|\banimation\s*:|\btransition\s*:/,
    'No CSS animations or transitions: they do not render frame by frame. Use interpolate()/spring() with the frame number.',
  ],
]

export function lintScene(code: string): string[] {
  const problems = FORBIDDEN.filter(([re]) => re.test(code)).map(([, why]) => why)
  if (!/(function\s+Scene\s*\(|(const|let)\s+Scene\s*=)/.test(code)) {
    problems.push(
      'Define the component as `function Scene({ brand, shots, durationInFrames }) { … }`.',
    )
  }
  return problems
}

export type CompiledScene = { ok: true; code: string } | { ok: false; error: string }

/** Contrôle puis compile le TSX d'une scène en JS exécutable dans le bundle Remotion (voir DynamicScene). */
export async function compileScene(source: string): Promise<CompiledScene> {
  const code = source.replace(/^\s*export\s+(default\s+)?/gm, '')
  const problems = lintScene(code)
  if (problems.length > 0) return { ok: false, error: problems.join('\n') }
  try {
    const out = await transform(code, {
      loader: 'tsx',
      jsx: 'transform',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      target: 'es2020',
    })
    return { ok: true, code: out.code }
  } catch (err) {
    return { ok: false, error: `Compilation error:\n${(err as Error).message.slice(0, 2000)}` }
  }
}
