import React from 'react'
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { Branding } from '../manifest.js'

interface CtaProps {
  headline: string
  buttonLabel: string
  branding: Branding
}

/**
 * Closing scene: big headline, accent-color CTA button, optional logo. No
 * screenshot — the eye lands on the button. Button has a subtle pulse so
 * the viewer's attention naturally moves there even on muted playback (most
 * social viewing happens muted).
 */
export const Cta: React.FC<CtaProps> = ({ headline, buttonLabel, branding }) => {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()

  const logoSpring = spring({ frame, fps, config: { damping: 18, stiffness: 110 } })
  const headlineSpring = spring({ frame: frame - 6, fps, config: { damping: 16, stiffness: 100 } })
  const buttonSpring = spring({ frame: frame - 18, fps, config: { damping: 14, stiffness: 110 } })

  const fadeOut = interpolate(
    frame,
    [durationInFrames - 12, durationInFrames],
    [1, 0],
    { extrapolateLeft: 'clamp' },
  )

  const headlineY = interpolate(headlineSpring, [0, 1], [40, 0])
  const headlineOpacity = interpolate(headlineSpring, [0, 1], [0, 1]) * fadeOut

  const logoScale = interpolate(logoSpring, [0, 1], [0.7, 1])
  const logoOpacity = interpolate(logoSpring, [0, 1], [0, 1]) * fadeOut

  const buttonScale = interpolate(buttonSpring, [0, 1], [0.85, 1])
  const buttonOpacity = interpolate(buttonSpring, [0, 1], [0, 1]) * fadeOut
  const buttonPulse = 1 + Math.sin(frame / 8) * 0.012

  return (
    <AbsoluteFill style={{ backgroundColor: branding.bgColor, overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 60%, ${branding.accentColor}40 0%, transparent 55%)`,
          opacity: fadeOut,
        }}
      />
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 48,
          padding: '0 120px',
        }}
      >
        {branding.logoUrl && (
          <Img
            src={branding.logoUrl}
            style={{
              height: 140,
              width: 'auto',
              maxWidth: 600,
              objectFit: 'contain',
              opacity: logoOpacity,
              transform: `scale(${logoScale})`,
            }}
          />
        )}
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
            opacity: headlineOpacity,
            transform: `translateY(${headlineY}px)`,
          }}
        >
          {headline}
        </h1>

        <div
          style={{
            opacity: buttonOpacity,
            transform: `scale(${buttonScale * buttonPulse})`,
            padding: '28px 64px',
            borderRadius: 16,
            background: branding.accentColor,
            color: '#FFFFFF',
            fontFamily: `'Geist', ${branding.fontFamily}, system-ui, sans-serif`,
            fontSize: 44,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            boxShadow: `0 20px 60px ${branding.accentColor}66, 0 0 0 1px ${branding.accentColor}88`,
          }}
        >
          {buttonLabel}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
