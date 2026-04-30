import React from 'react'
import { AbsoluteFill, Audio, useVideoConfig } from 'remotion'
import { TransitionSeries, linearTiming, springTiming } from '@remotion/transitions'
import { fade } from '@remotion/transitions/fade'
import { slide } from '@remotion/transitions/slide'
import { wipe } from '@remotion/transitions/wipe'
import { Hook } from './scenes/Hook.js'
import { FeatureScene } from './scenes/FeatureScene.js'
import { Cta } from './scenes/Cta.js'
import type { Manifest } from './manifest.js'

interface MarketingVideoProps {
  manifest: Manifest
}

/** Cycle of transition presets between scenes. Picked to feel intentional
 *  rather than random — fade for the hook → first scene (gentle entry),
 *  slide / wipe alternating between feature scenes (energy), fade out to
 *  the CTA (natural close). */
const TRANSITION_FRAMES = 18 // ~0.6s at 30fps — short enough not to bore,
                             // long enough to register as intentional motion.

const TRANSITIONS = [
  { presentation: fade(), timing: linearTiming({ durationInFrames: TRANSITION_FRAMES }) },
  { presentation: slide({ direction: 'from-right' }), timing: springTiming({ config: { damping: 200 }, durationInFrames: TRANSITION_FRAMES }) },
  { presentation: wipe({ direction: 'from-bottom-right' }), timing: linearTiming({ durationInFrames: TRANSITION_FRAMES }) },
  { presentation: slide({ direction: 'from-left' }), timing: springTiming({ config: { damping: 200 }, durationInFrames: TRANSITION_FRAMES }) },
] as const

/**
 * Strings the manifest's hook + scenes + CTA into a single video using
 * @remotion/transitions for varied scene-to-scene motion. The
 * TransitionSeries automatically overlaps adjacent <TransitionSeries.Sequence>
 * blocks by the transition duration — so the perceived scene length stays
 * what the script asked for, the transition just steals frames from the
 * outgoing scene's tail.
 *
 * Voice-over plays as a single Audio track over the whole composition;
 * Gemini already paced scene durations to spoken word counts at ~2.3 wps.
 */
export const MarketingVideo: React.FC<MarketingVideoProps> = ({ manifest }) => {
  const { fps } = useVideoConfig()
  const { script, screenshots, branding, voiceoverUrl, musicUrl, musicVolume } = manifest

  const hookFrames = Math.round(script.hook.durationSeconds * fps)
  const ctaFrames = Math.round(script.cta.durationSeconds * fps)

  return (
    <AbsoluteFill style={{ backgroundColor: branding.bgColor }}>
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={hookFrames}>
          <Hook headline={script.hook.headline} branding={branding} />
        </TransitionSeries.Sequence>

        {script.scenes.map((scene, i) => {
          const sceneFrames = Math.round(scene.durationSeconds * fps)
          const screenshot = scene.screenshotIndex != null ? screenshots[scene.screenshotIndex] ?? null : null
          // Transition BEFORE this scene — uses the i-th preset in the cycle.
          const t = TRANSITIONS[i % TRANSITIONS.length]!
          return (
            <React.Fragment key={i}>
              <TransitionSeries.Transition presentation={t.presentation} timing={t.timing} />
              <TransitionSeries.Sequence durationInFrames={sceneFrames}>
                <FeatureScene scene={scene} screenshot={screenshot} branding={branding} sceneIndex={i} />
              </TransitionSeries.Sequence>
            </React.Fragment>
          )
        })}

        {/* Always close on a soft fade to the CTA — feels like the end. */}
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
        />
        <TransitionSeries.Sequence durationInFrames={ctaFrames}>
          <Cta headline={script.cta.headline} buttonLabel={script.cta.buttonLabel} branding={branding} />
        </TransitionSeries.Sequence>
      </TransitionSeries>

      {voiceoverUrl && <Audio src={voiceoverUrl} />}
      {musicUrl && <Audio src={musicUrl} volume={musicVolume ?? 0.15} />}
    </AbsoluteFill>
  )
}

/**
 * Total composition duration in frames = the script's planned duration.
 *
 * Earlier this took max(script, voiceoverDuration) so a voice-over that
 * ran long wouldn't get clipped. In practice the result was a video
 * that lingered awkwardly past its visible end while the music had
 * already stopped — worse than a tightly cut audio. Now we trust the
 * script duration; if the synthesized MP3 overshoots by a fraction of
 * a second, the tail is clipped (acceptable). The script generator is
 * already nudged to leave room for audio-tag silence so this is rare.
 */
export function totalDurationInFrames(manifest: Manifest, fps: number): number {
  const { hook, scenes, cta } = manifest.script
  const scriptSec = hook.durationSeconds + scenes.reduce((a, s) => a + s.durationSeconds, 0) + cta.durationSeconds
  return Math.max(1, Math.round(scriptSec * fps))
}
