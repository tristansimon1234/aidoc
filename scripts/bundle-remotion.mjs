// Construit le bundle Remotion des vidéos marketing (dist/remotion-bundle), une fois par déploiement,
// et télécharge le navigateur headless de Remotion si besoin. Lancé par le Dockerfile du service vidéo.
import { bundle } from '@remotion/bundler'
import { ensureBrowser } from '@remotion/renderer'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'dist', 'remotion-bundle')

await bundle({
  entryPoint: join(root, 'remotion', 'index.ts'),
  outDir,
  // Les imports « ./Root.js » désignent des fichiers .tsx (TypeScript en ESM).
  webpackOverride: (config) => ({
    ...config,
    resolve: {
      ...config.resolve,
      extensionAlias: { '.js': ['.tsx', '.ts', '.js'] },
    },
  }),
})
console.log(`[remotion] bundle → ${outDir}`)

if (!process.env.REMOTION_BROWSER_EXECUTABLE) await ensureBrowser()
