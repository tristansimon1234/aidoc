// Rendu Remotion (vidéos marketing) sur le service vidéo : test d'une scène en quelques images,
// puis rendu de la vidéo complète (sans son : la voix et la musique sont ajoutées par ffmpeg).
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
  type HeadlessBrowser,
} from '@remotion/renderer'
import { env } from '../env.js'
import type { MarketingProps, ScenePreviewProps } from '../../remotion/props.js'

const BUILT_BUNDLE = join(process.cwd(), 'dist', 'remotion-bundle')
let devBundle: Promise<string> | null = null

/** Bundle construit au déploiement (scripts/bundle-remotion.mjs) ; en local, construit à la volée. */
function serveUrl(): Promise<string> {
  if (existsSync(join(BUILT_BUNDLE, 'index.html'))) return Promise.resolve(BUILT_BUNDLE)
  devBundle ??= import('@remotion/bundler').then(({ bundle }) =>
    bundle({
      entryPoint: join(process.cwd(), 'remotion', 'index.ts'),
      webpackOverride: (config) => ({
        ...config,
        resolve: { ...config.resolve, extensionAlias: { '.js': ['.tsx', '.ts', '.js'] } },
      }),
    }),
  )
  return devBundle
}

/** Un navigateur headless partagé par tous les rendus d'une vidéo. */
export async function withBrowser<R>(fn: (browser: HeadlessBrowser) => Promise<R>): Promise<R> {
  const browser = await openBrowser('chrome', {
    browserExecutable: env.REMOTION_BROWSER_EXECUTABLE ?? null,
    chromiumOptions: { gl: 'swangle' },
  })
  try {
    return await fn(browser)
  } finally {
    await browser.close({ silent: true }).catch(() => {})
  }
}

/**
 * Rend quelques images d'une scène seule (PNG, demi-résolution). Une erreur dans le code de la scène
 * fait échouer le rendu : le message est renvoyé tel quel pour que l'IA corrige.
 */
export async function renderSceneStills(
  browser: HeadlessBrowser,
  props: ScenePreviewProps,
  frames: number[],
  dir: string,
  name: string,
): Promise<Buffer[]> {
  const url = await serveUrl()
  const common = {
    serveUrl: url,
    inputProps: props,
    puppeteerInstance: browser,
    browserExecutable: env.REMOTION_BROWSER_EXECUTABLE ?? null,
    logLevel: 'error' as const,
  }
  const composition = await selectComposition({ ...common, id: 'ScenePreview' })
  const images: Buffer[] = []
  for (const [i, frame] of frames.entries()) {
    const output = join(dir, `${name}-${i}.png`)
    await renderStill({
      ...common,
      composition,
      frame: Math.min(Math.max(0, frame), composition.durationInFrames - 1),
      output,
      imageFormat: 'png',
      scale: 0.5,
    })
    images.push(await readFile(output))
  }
  return images
}

/** Rend la vidéo complète en MP4 (H.264, sans son). */
export async function renderMarketingVideo(
  browser: HeadlessBrowser,
  props: MarketingProps,
  output: string,
): Promise<void> {
  const url = await serveUrl()
  const common = {
    serveUrl: url,
    inputProps: props,
    puppeteerInstance: browser,
    browserExecutable: env.REMOTION_BROWSER_EXECUTABLE ?? null,
    logLevel: 'error' as const,
  }
  const composition = await selectComposition({ ...common, id: 'Marketing' })
  await renderMedia({
    ...common,
    composition,
    codec: 'h264',
    crf: 20,
    muted: true,
    outputLocation: output,
  })
}
