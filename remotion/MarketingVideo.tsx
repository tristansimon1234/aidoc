import React from 'react'
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion'
import type { Brand, MarketingProps, SceneProps, ScenePreviewProps } from './props.js'
import { DynamicScene } from './DynamicScene.js'
import { Captions } from './Captions.js'
import { fontFamily } from './fonts.js'

/** Fondu rapide à l'entrée de chaque scène (sauf la première). */
const FADE = 8

const FadeIn: React.FC<{ children: React.ReactNode; enabled: boolean }> = ({
  children,
  enabled,
}) => {
  const frame = useCurrentFrame()
  const opacity = enabled ? interpolate(frame, [0, FADE], [0, 1], { extrapolateRight: 'clamp' }) : 1
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>
}

/** La vidéo complète : les scènes bout à bout, puis les sous-titres par-dessus. La voix est ajoutée par ffmpeg. */
export const MarketingVideo: React.FC<MarketingProps> = ({ brand, scenes, captions }) => {
  let from = 0
  return (
    <AbsoluteFill style={{ background: brand.background, fontFamily }}>
      {scenes.map((scene, i) => {
        const start = from
        from += scene.durationInFrames
        return (
          <Sequence key={i} from={start} durationInFrames={scene.durationInFrames}>
            <FadeIn enabled={i > 0}>
              <DynamicScene scene={scene} brand={brand} strict={false} />
            </FadeIn>
          </Sequence>
        )
      })}
      <Captions words={captions} brand={brand} />
    </AbsoluteFill>
  )
}

/** Une seule scène, pour la tester : une erreur dans son code fait échouer le rendu (et remonte à l'IA). */
export const ScenePreview: React.FC<ScenePreviewProps> = ({ brand, scene }) => (
  <AbsoluteFill style={{ background: brand.background, fontFamily }}>
    <DynamicScene scene={scene} brand={brand} strict />
  </AbsoluteFill>
)

export function totalFrames(scenes: SceneProps[]): number {
  return Math.max(
    1,
    scenes.reduce((sum, s) => sum + s.durationInFrames, 0),
  )
}

export type { Brand }
