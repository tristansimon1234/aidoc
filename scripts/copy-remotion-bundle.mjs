/**
 * Copies the Remotion bundle output (`dist/remotion-bundle/`) into Vite's
 * `public/remotion-bundle/`, where it gets picked up at `vite build` and
 * shipped as a static asset of the Doclee app.
 *
 * Wired via the `prebuild` script in package.json so a fresh bundle gets
 * served at `${PUBLIC_APP_URL}/remotion-bundle/` on every deploy — that's
 * the URL the video-service hits for `selectComposition` + `renderMedia`.
 *
 * Plain Node ESM (.mjs) — runs on Vercel without ts-node, which isn't a
 * declared dep here.
 */
import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const src = join(repoRoot, 'dist', 'remotion-bundle')
const dst = join(repoRoot, 'public', 'remotion-bundle')

if (!existsSync(src)) {
  console.error(`[copy-remotion-bundle] Source not found: ${src}`)
  console.error('[copy-remotion-bundle] Run `npm run remotion:bundle` first.')
  process.exit(1)
}

if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
mkdirSync(dirname(dst), { recursive: true })
cpSync(src, dst, { recursive: true })
console.log(`[copy-remotion-bundle] ${src} → ${dst}`)
