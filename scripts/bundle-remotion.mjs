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

// Where the bundle will be served from on the deployed app. The bundle's
// index.html references its JS via this prefix; without it, the script
// tag becomes `/bundle.js` (root) and Vercel's SPA-fallback rewrite
// returns the React app shell when Chromium tries to load it — which is
// what causes "Unexpected token '<'" inside Remotion's selectComposition.
const PUBLIC_PATH = '/remotion-bundle/'

console.log(`[remotion-bundle] Bundling ${entryPoint}`)
console.log(`[remotion-bundle] Output    ${outDir}`)
console.log(`[remotion-bundle] PublicPath ${PUBLIC_PATH}`)

// The Remotion source uses TS NodeNext-style imports (`./Root.js` referring
// to `Root.tsx`). Webpack 5's default resolver looks for the literal `.js`
// file and fails. `extensionAlias` tells it to try `.tsx` / `.ts` first when
// it sees a `.js` import — the standard fix for ESM TypeScript on webpack.
const bundled = await bundle({
  entryPoint,
  outDir,
  publicPath: PUBLIC_PATH,
  webpackOverride: (config) => ({
    ...config,
    resolve: {
      ...(config.resolve ?? {}),
      extensionAlias: {
        ...(config.resolve?.extensionAlias ?? {}),
        '.js': ['.tsx', '.ts', '.js'],
        '.jsx': ['.tsx', '.jsx'],
      },
    },
  }),
})

console.log(`[remotion-bundle] Done → ${bundled}`)
