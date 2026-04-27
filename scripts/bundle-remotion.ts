/**
 * Pre-bundle the Remotion compositions to a self-contained directory the
 * video-service can render from. Output goes to `dist/remotion-bundle/` —
 * a folder of static assets servable over HTTP.
 *
 *   npm run remotion:bundle
 *
 * Distribution options once bundled (pick whichever fits your infra):
 *  1. **Vercel public asset**: copy `dist/remotion-bundle/` into `public/`
 *     before `vercel build`. The video-service reads from
 *     `${PUBLIC_APP_URL}/remotion-bundle/`. Simplest path.
 *  2. **Supabase Storage**: zip + upload to a public bucket, video-service
 *     downloads + unzips on demand. Better for cold-start speed if you have
 *     many video-service instances.
 *  3. **Bake into the video-service Docker image**: COPY the bundle at
 *     build time. Best perf, worst iteration loop (Doclee + video-service
 *     deploys are coupled).
 *
 * Whichever route you pick, the URL ends up in REMOTION_SERVE_URL on the
 * Doclee env so resolveRemotionServeUrl() in marketing-video.service.ts
 * picks it up.
 */
import { bundle } from '@remotion/bundler'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

async function main(): Promise<void> {
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
  console.log('')
  console.log('Next: serve dist/remotion-bundle/ over HTTP and set REMOTION_SERVE_URL')
  console.log('to the public URL of the bundle root. See scripts/bundle-remotion.ts header.')
}

main().catch((err: unknown) => {
  console.error('[remotion-bundle] Failed:', err)
  process.exit(1)
})
