import React from 'react'
import { Composition } from 'remotion'
import { MarketingVideo, totalDurationInFrames } from './MarketingVideo.js'
import { ManifestSchema, type Manifest } from './manifest.js'
import { SAMPLE_MANIFEST } from './sample-manifest.js'

const FPS = 30
const WIDTH = 1920
const HEIGHT = 1080

/**
 * Loads the manifest the CLI writes to `remotion/manifest.json` (created by
 * `npm run marketing:preview <runId>`). If the file isn't there — typical
 * when a designer opens `npx remotion preview` cold — fall back to the
 * bundled sample manifest so the template is always renderable.
 *
 * We require() at module load instead of dynamic-importing async because
 * Composition.defaultProps must resolve synchronously.
 */
function loadDefaultManifest(): Manifest {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const data = require('../manifest.json') as unknown
    const parsed = ManifestSchema.safeParse(data)
    if (parsed.success) return parsed.data
    console.warn('[remotion] manifest.json failed validation, falling back to sample:', parsed.error.flatten())
  } catch {
    // No manifest.json — silent fallback to sample.
  }
  return SAMPLE_MANIFEST
}

const defaultManifest = loadDefaultManifest()

/**
 * The durationInFrames depends on the manifest in inputProps, which the
 * server passes per-render. `calculateMetadata` is Remotion's hook for
 * deriving metadata from props at render time — without it, every server
 * render would inherit the local manifest.json's duration, which is wrong.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MarketingVideo"
        component={MarketingVideo}
        durationInFrames={Math.max(1, totalDurationInFrames(defaultManifest, FPS))}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{ manifest: defaultManifest }}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(1, totalDurationInFrames(props.manifest, FPS)),
        })}
      />
    </>
  )
}
