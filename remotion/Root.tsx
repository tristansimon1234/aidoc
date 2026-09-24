import React from 'react'
import { Composition } from 'remotion'
import { MarketingVideo, ScenePreview, totalFrames } from './MarketingVideo.js'
import { VIDEO_FPS, type MarketingProps, type ScenePreviewProps } from './props.js'

const brand = {
  productName: 'Doclee',
  accent: '#7C5CFF',
  accent2: '#FFD84D',
  background: '#0E0B1F',
  text: '#FFFFFF',
}

const scene = { code: null, durationInFrames: 90, shots: [], headline: 'Your product, in motion' }

// Les dimensions et la durée viennent des données (16:9 ou 9:16, durée = somme des scènes).
export const Root: React.FC = () => (
  <>
    <Composition
      id="Marketing"
      component={MarketingVideo}
      fps={VIDEO_FPS}
      width={1920}
      height={1080}
      durationInFrames={90}
      defaultProps={
        { width: 1920, height: 1080, brand, scenes: [scene], captions: [] } satisfies MarketingProps
      }
      calculateMetadata={({ props }) => ({
        width: props.width,
        height: props.height,
        durationInFrames: totalFrames(props.scenes),
      })}
    />
    <Composition
      id="ScenePreview"
      component={ScenePreview}
      fps={VIDEO_FPS}
      width={1920}
      height={1080}
      durationInFrames={90}
      defaultProps={{ width: 1920, height: 1080, brand, scene } satisfies ScenePreviewProps}
      calculateMetadata={({ props }) => ({
        width: props.width,
        height: props.height,
        durationInFrames: Math.max(1, props.scene.durationInFrames),
      })}
    />
  </>
)
