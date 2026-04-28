import React from 'react'
import { Img, interpolate, useCurrentFrame } from 'remotion'
import type { Branding } from '../manifest.js'

interface BrandWatermarkProps {
  branding: Branding
  /** Where to anchor the watermark. Defaults to top-right. */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  /** Logo height in px. Defaults to a discreet 56 — visible without
   *  competing with scene content. */
  size?: number
}

/**
 * Small persistent brand mark (logo + product name) anchored to a corner of
 * the canvas. Used on Hook + Feature scenes so the brand is present without
 * interrupting the story; the CTA scene shows a much larger logo treatment
 * inline instead.
 *
 * Falls back to a text-only badge when `branding.logoUrl` is null so we
 * still get brand recall on projects that haven't uploaded a logo.
 */
export const BrandWatermark: React.FC<BrandWatermarkProps> = ({
  branding,
  position = 'top-right',
  size = 56,
}) => {
  const frame = useCurrentFrame()

  const fadeIn = interpolate(frame, [6, 18], [0, 1], { extrapolateRight: 'clamp' })

  const offsets: Record<NonNullable<BrandWatermarkProps['position']>, React.CSSProperties> = {
    'top-left':     { top: 56, left: 64 },
    'top-right':    { top: 56, right: 64 },
    'bottom-left':  { bottom: 56, left: 64 },
    'bottom-right': { bottom: 56, right: 64 },
  }

  return (
    <div
      style={{
        position: 'absolute',
        ...offsets[position],
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        opacity: fadeIn,
        pointerEvents: 'none',
      }}
    >
      {branding.logoUrl ? (
        <Img
          src={branding.logoUrl}
          style={{
            height: size,
            width: 'auto',
            maxWidth: size * 4,
            objectFit: 'contain',
          }}
        />
      ) : (
        <span
          style={{
            fontFamily: `${branding.fontFamily}, 'Geist', system-ui, sans-serif`,
            color: branding.textColor,
            fontSize: size * 0.5,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            opacity: 0.85,
          }}
        >
          {branding.productName}
        </span>
      )}
    </div>
  )
}
