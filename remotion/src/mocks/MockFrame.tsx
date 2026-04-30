import React from 'react'
import { frameSurface } from './tones.js'

interface MockFrameProps {
  url?: string
  tone?: 'light' | 'dark'
  children: React.ReactNode
  /** Width / height of the inner canvas in px. Default sized for a
   *  typical FeatureScene "screenshot slot" (920×580). */
  width?: number
  height?: number
}

/**
 * Browser-chrome wrapper around mock content. Renders the macOS-style
 * traffic-light buttons + a URL bar at the top, then the children fill
 * the rest. `tone` swaps the whole surface to a dark theme suitable for
 * code/terminal mocks vs a light theme for product UI mocks.
 */
export const MockFrame: React.FC<MockFrameProps> = ({
  url,
  tone = 'light',
  children,
  width = 920,
  height = 580,
}) => {
  const surface = frameSurface(tone)
  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        borderRadius: 18,
        overflow: 'hidden',
        background: surface.bg,
        border: `1px solid ${surface.border}`,
        boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: 36,
          flexShrink: 0,
          background: surface.chromeBg,
          borderBottom: `1px solid ${surface.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 14px',
        }}
      >
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#FF5F56' }} />
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#FFBD2E' }} />
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#27C93F' }} />
        {url && (
          <div
            style={{
              flex: 1,
              marginLeft: 16,
              padding: '4px 12px',
              borderRadius: 6,
              background: tone === 'dark' ? '#FFFFFF10' : '#FFFFFF',
              border: `1px solid ${surface.border}`,
              color: surface.chromeFg,
              fontSize: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {url}
          </div>
        )}
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}
