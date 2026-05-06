import React from 'react'
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { Branding } from '../manifest.js'
import { Icons } from './mock-helpers.js'

interface CtaProps {
  headline: string
  buttonLabel: string
  branding: Branding
}

/**
 * Closing scene — the "outro card". Composition: brand lockup at the top
 * (logo + product name), headline in the middle, primary CTA button with a
 * chevron, product URL underneath. Looks like a polished end-card from a
 * keynote rather than a generated stub. All elements stagger in with
 * spring; the button has a subtle pulse so the eye lands on it even on
 * muted playback.
 */
export const Cta: React.FC<CtaProps> = ({ headline, buttonLabel, branding }) => {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()

  const logoT = spring({ frame, fps, config: { damping: 18, stiffness: 110 } })
  const headlineT = spring({ frame: frame - 8, fps, config: { damping: 16, stiffness: 100 } })
  const buttonT = spring({ frame: frame - 22, fps, config: { damping: 14, stiffness: 110 } })
  const urlT = spring({ frame: frame - 30, fps, config: { damping: 16, stiffness: 100 } })

  const fadeOut = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], { extrapolateLeft: 'clamp' })

  const headlineY = interpolate(headlineT, [0, 1], [40, 0])
  const headlineOpacity = interpolate(headlineT, [0, 1], [0, 1]) * fadeOut

  const logoScale = interpolate(logoT, [0, 1], [0.7, 1])
  const logoOpacity = interpolate(logoT, [0, 1], [0, 1]) * fadeOut

  const buttonScale = interpolate(buttonT, [0, 1], [0.85, 1])
  const buttonOpacity = interpolate(buttonT, [0, 1], [0, 1]) * fadeOut
  const buttonPulse = 1 + Math.sin(frame / 8) * 0.014

  const urlOpacity = interpolate(urlT, [0, 1], [0, 0.6]) * fadeOut

  // Use the project's actual website URL when set (resolved from
  // `projects.base_url` upstream). Fall back to a slugified guess for
  // older manifests that pre-date the websiteUrl field — `.com` is wrong
  // for ~half the top-level domains in the wild but it's a one-off
  // legacy fallback, not the steady state.
  const productUrl = branding.websiteUrl
    ? branding.websiteUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    : `${branding.productName.toLowerCase().replace(/\s+/g, '')}.com`

  // Chevron arrow icon for the button — same accent the rest of the brand uses.
  const ChevronRight = (Icons as unknown as Record<string, React.FC<{ size?: number; color?: string }>>)['ChevronRight']

  return (
    <AbsoluteFill style={{ backgroundColor: branding.bgColor, overflow: 'hidden' }}>
      {/* Layered accent gradient — bigger than the hook's, anchored at the
          button area to draw attention. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 65%, ${branding.accentColor}40 0%, ${branding.accentColor}1A 35%, transparent 60%)`,
          opacity: fadeOut,
        }}
      />

      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 36,
          padding: '0 120px',
        }}
      >
        {/* Brand lockup at the top: logo + product name side by side */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            opacity: logoOpacity,
            transform: `scale(${logoScale})`,
          }}
        >
          {branding.logoUrl && (
            <Img
              src={branding.logoUrl}
              style={{
                height: 64, width: 'auto', maxWidth: 200,
                objectFit: 'contain',
                filter: `drop-shadow(0 8px 16px ${branding.accentColor}33)`,
              }}
            />
          )}
          <span
            style={{
              fontFamily: `${branding.fontFamily}, 'Geist', system-ui, sans-serif`,
              fontSize: 36, fontWeight: 700, letterSpacing: '-0.02em',
              color: branding.textColor,
            }}
          >
            {branding.productName}
          </span>
        </div>

        {/* Headline */}
        <h1
          style={{
            color: branding.textColor,
            fontFamily: `${branding.fontFamily}, 'Geist', system-ui, sans-serif`,
            fontSize: 96,
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
          {headline}
        </h1>

        {/* Button with chevron */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 16,
            padding: '24px 56px',
            borderRadius: 999,
            background: `linear-gradient(135deg, ${branding.accentColor}, ${branding.accentColor}DD)`,
            color: '#FFFFFF',
            fontFamily: `${branding.fontFamily}, 'Geist', system-ui, sans-serif`,
            fontSize: 38,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            boxShadow: `0 24px 60px -8px ${branding.accentColor}66, 0 0 0 1px ${branding.accentColor}AA`,
            opacity: buttonOpacity,
            transform: `scale(${buttonScale * buttonPulse})`,
          }}
        >
          <span>{buttonLabel}</span>
          {ChevronRight && <ChevronRight size={32} color="#FFFFFF" />}
        </div>

        {/* Product URL — small + muted, keeps the focal point on the button */}
        <span
          style={{
            fontFamily: `ui-monospace, SFMono-Regular, Menlo, monospace`,
            fontSize: 22,
            color: branding.textColor,
            opacity: urlOpacity,
            letterSpacing: '0.02em',
            marginTop: -8,
          }}
        >
          {productUrl}
        </span>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
