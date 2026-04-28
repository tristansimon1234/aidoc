import React from 'react'
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { Branding } from '../manifest.js'
import { BrandWatermark } from './BrandWatermark.js'

interface HookProps {
  headline: string
  branding: Branding
}

/**
 * Opening 5-8s of the marketing video. Big animated headline on a dark
 * background with a subtle accent-color glow. No screenshot — the hook is
 * the *idea*, not the product. Screenshots come in starting from scene 1.
 */
export const Hook: React.FC<HookProps> = ({ headline, branding }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const headlineSpring = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 95, mass: 0.7 },
  })
  const translateY = interpolate(headlineSpring, [0, 1], [40, 0])
  const opacity = interpolate(frame, [0, 12, 100, 130], [0, 1, 1, 0], {
    extrapolateRight: 'clamp',
  })

  const glowPulse = interpolate(
    frame % 90,
    [0, 45, 90],
    [0.35, 0.6, 0.35],
  )

  return (
    <AbsoluteFill style={{ backgroundColor: branding.bgColor, overflow: 'hidden' }}>
      <BrandWatermark branding={branding} position="top-right" size={64} />
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 50%, ${branding.accentColor}33 0%, transparent 60%)`,
          opacity: glowPulse,
        }}
      />
      <AbsoluteFill
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 120px',
          opacity,
          transform: `translateY(${translateY}px)`,
        }}
      >
        <h1
          style={{
            color: branding.textColor,
            fontFamily: `'Geist', ${branding.fontFamily}, system-ui, sans-serif`,
            fontSize: 130,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: '-0.03em',
            textAlign: 'center',
            margin: 0,
          }}
        >
          {headline}
        </h1>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
