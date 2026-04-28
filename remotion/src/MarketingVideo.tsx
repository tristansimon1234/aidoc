import React from 'react'
import { AbsoluteFill, Audio, Sequence, useVideoConfig } from 'remotion'
import { Hook } from './scenes/Hook.js'
import { FeatureScene } from './scenes/FeatureScene.js'
import { Cta } from './scenes/Cta.js'
import type { Manifest } from './manifest.js'

interface MarketingVideoProps {
  manifest: Manifest
}

/**
 * Strings the manifest's hook + scenes + CTA into a single video. Each
 * scene gets a Sequence with its own frame range derived from
 * `durationSeconds` — Remotion's `useCurrentFrame` inside a Sequence is
 * scoped to that sub-range, which is why the scene components can run
 * intro/outro animations off frame 0.
 *
 * The voice-over (when present) plays as a single Audio track over the
 * whole composition. Scene durations were already chosen by Gemini to
 * match the spoken word counts at ~2.3 wps, so no per-scene sync is
 * needed.
 */
export const MarketingVideo: React.FC<MarketingVideoProps> = ({ manifest }) => {
  const { fps } = useVideoConfig()
  const { script, screenshots, branding, voiceoverUrl, musicUrl, musicVolume } = manifest

  let cursorFrames = 0
  const sceneSegments: { from: number; durationInFrames: number; element: React.ReactNode }[] = []

  const hookFrames = Math.round(script.hook.durationSeconds * fps)
  sceneSegments.push({
    from: cursorFrames,
    durationInFrames: hookFrames,
    element: <Hook headline={script.hook.headline} branding={branding} />,
  })
  cursorFrames += hookFrames

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i]!
    const sceneFrames = Math.round(scene.durationSeconds * fps)
    const screenshot = scene.screenshotIndex != null ? screenshots[scene.screenshotIndex] ?? null : null
    sceneSegments.push({
      from: cursorFrames,
      durationInFrames: sceneFrames,
      element: <FeatureScene scene={scene} screenshot={screenshot} branding={branding} />,
    })
    cursorFrames += sceneFrames
  }

  const ctaFrames = Math.round(script.cta.durationSeconds * fps)
  sceneSegments.push({
    from: cursorFrames,
    durationInFrames: ctaFrames,
    element: <Cta headline={script.cta.headline} buttonLabel={script.cta.buttonLabel} branding={branding} />,
  })

  return (
    <AbsoluteFill style={{ backgroundColor: branding.bgColor }}>
      {sceneSegments.map((seg, i) => (
        <Sequence key={i} from={seg.from} durationInFrames={seg.durationInFrames}>
          {seg.element}
        </Sequence>
      ))}
      {voiceoverUrl && <Audio src={voiceoverUrl} />}
      {musicUrl && <Audio src={musicUrl} volume={musicVolume ?? 0.15} />}
    </AbsoluteFill>
  )
}

/**
 * Total composition duration in frames given a manifest. Exported so the
 * Composition's `durationInFrames` prop in Root.tsx can compute it without
 * duplicating the logic.
 */
export function totalDurationInFrames(manifest: Manifest, fps: number): number {
  const { hook, scenes, cta } = manifest.script
  const sec = hook.durationSeconds + scenes.reduce((a, s) => a + s.durationSeconds, 0) + cta.durationSeconds
  return Math.round(sec * fps)
}
