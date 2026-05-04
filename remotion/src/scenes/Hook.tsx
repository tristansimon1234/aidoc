import React from 'react'
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { Branding } from '../manifest.js'

interface HookProps {
  headline: string
  branding: Branding
}

/**
 * Opening 5-8s of the marketing video. A "logo reveal" moment in the first
 * ~1s (logo scales in over an accent gradient burst), then the headline
 * cross-fades in below. The combination establishes the brand from frame
 * one — the difference between "AI-generated promo" and "actual product".
 */
export const Hook: React.FC<HookProps> = ({ headline, branding }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // Logo reveal: scales in, settles, then drifts up slightly to make
  // room for the headline.
  const logoSpring = spring({ frame, fps, config: { damping: 16, stiffness: 100, mass: 0.8 } })
  const logoOpacity = interpolate(frame, [0, 8, 130, 150], [0, 1, 1, 0], { extrapolateRight: 'clamp' })
  const logoScale = interpolate(logoSpring, [0, 1], [0.6, 1])
  // Logo settles around frame 18, then drifts up ~40px starting frame 22 to
  // visually "make room" for the headline below.
  const logoDrift = interpolate(frame, [22, 38], [0, -40], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })

  // Headline arrives ~22 frames after the logo reveal starts. Spring entry,
  // accent shimmer on the first word, settles before the hold.
  const headlineSpring = spring({ frame: frame - 22, fps, config: { damping: 14, stiffness: 95, mass: 0.7 } })
  const headlineY = interpolate(headlineSpring, [0, 1], [40, 0])
  const headlineOpacity = interpolate(frame, [22, 34, 130, 150], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })

  // Accent gradient burst pulses subtly behind the whole composition.
  const burstScale = interpolate(spring({ frame, fps, config: { damping: 18, stiffness: 60 } }), [0, 1], [0.4, 1])
  const burstOpacity = interpolate(frame, [0, 14, 130, 150], [0, 1, 0.8, 0], { extrapolateRight: 'clamp' })
  const glowPulse = interpolate(frame % 90, [0, 45, 90], [0.6, 0.85, 0.6])

  // First word gets an accent color treatment — the eye lands there first.
  const words = headline.split(/\s+/).filter(Boolean)
  const firstWord = words[0]
  const restWords = words.slice(1).join(' ')

  return (
    <AbsoluteFill style={{ backgroundColor: branding.bgColor, overflow: 'hidden' }}>
      {/* Accent gradient burst — radial behind the logo lockup */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 42%, ${branding.accentColor}40 0%, ${branding.accentColor}1A 30%, transparent 60%)`,
          opacity: burstOpacity * glowPulse,
          transform: `scale(${burstScale})`,
        }}
      />

      {/* Composition: logo top-center → headline below */}
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 120px',
          gap: 48,
        }}
      >
        {branding.logoUrl ? (
          <Img
            src={branding.logoUrl}
            style={{
              height: 140,
              width: 'auto',
              maxWidth: 520,
              objectFit: 'contain',
              opacity: logoOpacity,
              transform: `scale(${logoScale}) translateY(${logoDrift}px)`,
              filter: `drop-shadow(0 20px 40px ${branding.accentColor}33)`,
            }}
          />
        ) : (
          // No logo URL — show the product name in the brand's accent color
          // as the lockup. Better than blank space.
          <span
            style={{
              fontFamily: `${branding.fontFamily}, 'Geist', system-ui, sans-serif`,
              fontSize: 56, fontWeight: 700, letterSpacing: '-0.02em',
              color: branding.accentColor,
              opacity: logoOpacity,
              transform: `scale(${logoScale}) translateY(${logoDrift}px)`,
            }}
          >
            {branding.productName}
          </span>
        )}

        <h1
          style={{
            color: branding.textColor,
            fontFamily: `${branding.fontFamily}, 'Geist', system-ui, sans-serif`,
            fontSize: 110,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: '-0.03em',
            textAlign: 'center',
            margin: 0,
            maxWidth: 1400,
            opacity: headlineOpacity,
            transform: `translateY(${headlineY}px)`,
          }}
        >
          {firstWord && (
            <span style={{ color: branding.accentColor }}>{firstWord}</span>
          )}
          {restWords && <span> {restWords}</span>}
        </h1>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
