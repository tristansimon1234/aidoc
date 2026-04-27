import React from 'react'
import { Composition } from 'remotion'
import { MarketingVideo, totalDurationInFrames } from './MarketingVideo.js'
import { SAMPLE_MANIFEST } from './sample-manifest.js'

const FPS = 30
const WIDTH = 1920
const HEIGHT = 1080

/**
 * The composition uses the bundled SAMPLE_MANIFEST as defaultProps so the
 * template is always renderable cold. Real-data preview locally:
 *   npm run marketing:preview <runId>            # writes remotion/manifest.json
 *   npm run remotion:preview                     # passes --props=manifest.json
 * Real-data render in production: the video-service passes the manifest as
 * inputProps to selectComposition + renderMedia, and `calculateMetadata`
 * recomputes durationInFrames from those props.
 *
 * Why no static `require('../manifest.json')`: webpack tries to resolve
 * static requires at bundle time, and on Vercel that file doesn't exist
 * (it's a local CLI artifact). The build would fail and Vercel would keep
 * serving the previous deploy. Inlining the sample + relying on --props /
 * inputProps avoids any filesystem dependency at bundle time.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MarketingVideo"
        component={MarketingVideo}
        durationInFrames={Math.max(1, totalDurationInFrames(SAMPLE_MANIFEST, FPS))}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{ manifest: SAMPLE_MANIFEST }}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(1, totalDurationInFrames(props.manifest, FPS)),
        })}
      />
    </>
  )
}
