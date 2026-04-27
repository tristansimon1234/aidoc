import React from 'react'
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { Branding, Scene, Screenshot } from '../manifest.js'

interface FeatureSceneProps {
  scene: Scene
  screenshot: Screenshot | null
  branding: Branding
}

/**
 * Mid-act scenes — one benefit, one screenshot, one headline.
 * Layout: headline + subhead in a left rail, screenshot floating right with
 * a subtle parallax + accent-color glow. Both elements animate in offset by
 * a few frames so the eye lands on the headline first, then the visual.
 *
 * The screenshot can be null (e.g. for scenes that the script generator
 * decided to keep headline-only); falls back to a tinted accent panel so
 * the layout doesn't collapse.
 */
export const FeatureScene: React.FC<FeatureSceneProps> = ({ scene, screenshot, branding }) => {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()

  const textIn = spring({ frame: frame - 4, fps, config: { damping: 18, stiffness: 90 } })
  const imgIn = spring({ frame: frame - 12, fps, config: { damping: 18, stiffness: 90 } })

  const fadeOut = interpolate(
    frame,
    [durationInFrames - 14, durationInFrames],
    [1, 0],
    { extrapolateLeft: 'clamp' },
  )

  const headlineY = interpolate(textIn, [0, 1], [30, 0])
  const headlineOpacity = interpolate(textIn, [0, 1], [0, 1]) * fadeOut

  const imgX = interpolate(imgIn, [0, 1], [80, 0])
  const imgOpacity = interpolate(imgIn, [0, 1], [0, 1]) * fadeOut
  const imgFloat = Math.sin(frame / 30) * 6

  return (
    <AbsoluteFill style={{ backgroundColor: branding.bgColor, overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 80% 50%, ${branding.accentColor}22 0%, transparent 65%)`,
          opacity: fadeOut,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 100,
          top: 0,
          bottom: 0,
          width: 720,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 24,
          opacity: headlineOpacity,
          transform: `translateY(${headlineY}px)`,
        }}
      >
        <div
          style={{
            display: 'inline-block',
            padding: '6px 14px',
            borderRadius: 999,
            background: `${branding.accentColor}25`,
            color: branding.accentColor,
            fontFamily: `${branding.fontFamily}, system-ui, sans-serif`,
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            alignSelf: 'flex-start',
          }}
        >
          {branding.productName}
        </div>
        <h2
          style={{
            color: branding.textColor,
            fontFamily: `${branding.fontFamily}, system-ui, sans-serif`,
            fontSize: 92,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: '-0.025em',
            margin: 0,
          }}
        >
          {scene.headline}
        </h2>
        {scene.subhead && (
          <p
            style={{
              color: `${branding.textColor}B0`,
              fontFamily: `${branding.fontFamily}, system-ui, sans-serif`,
              fontSize: 32,
              fontWeight: 400,
              lineHeight: 1.35,
              letterSpacing: '-0.005em',
              margin: 0,
              maxWidth: 680,
            }}
          >
            {scene.subhead}
          </p>
        )}
      </div>

      <div
        style={{
          position: 'absolute',
          right: 100,
          top: '50%',
          width: 920,
          height: 580,
          marginTop: -290,
          opacity: imgOpacity,
          transform: `translate(${imgX}px, ${imgFloat}px)`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: -20,
            borderRadius: 28,
            background: `linear-gradient(135deg, ${branding.accentColor}66, transparent)`,
            filter: 'blur(40px)',
          }}
        />
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            borderRadius: 18,
            overflow: 'hidden',
            border: `1px solid ${branding.textColor}22`,
            boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
            background: `${branding.textColor}08`,
          }}
        >
          {screenshot ? (
            <Img
              src={screenshot.url}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <AbsoluteFill
              style={{
                background: `linear-gradient(135deg, ${branding.accentColor}55, ${branding.bgColor})`,
              }}
            />
          )}
        </div>
      </div>
    </AbsoluteFill>
  )
}
