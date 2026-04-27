/**
 * Pre-bundle the Remotion compositions to a self-contained directory the
 * video-service can render from. Output goes to `dist/remotion-bundle/` —
 * a folder of static assets servable over HTTP.
 *
 *   npm run remotion:bundle
 *
 * On Vercel deploys this runs automatically via `prebuild` followed by
 * `copy-remotion-bundle.mjs` which moves the output into `public/` so
 * Vite ships it as a static asset at `${PUBLIC_APP_URL}/remotion-bundle/`.
 *
 * Plain Node ESM (.mjs) so the Vercel build runs it without ts-node.
 */
import { bundle } from '@remotion/bundler'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const entryPoint = join(repoRoot, 'remotion', 'src', 'index.ts')
const outDir = join(repoRoot, 'dist', 'remotion-bundle')

console.log(`[remotion-bundle] Bundling ${entryPoint}`)
console.log(`[remotion-bundle] Output    ${outDir}`)

const bundled = await bundle({
  entryPoint,
  outDir,
  webpackOverride: (config) => config,
})

console.log(`[remotion-bundle] Done → ${bundled}`)
