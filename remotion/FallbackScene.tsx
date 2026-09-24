import React from 'react'
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { Brand, SceneProps } from './props.js'
import { AccentGlow, Screenshot } from './toolkit/helpers.js'

/** Scène sobre utilisée quand l'IA n'a pas produit de code valable : titre + capture en mouvement. */
export const FallbackScene: React.FC<{ scene: SceneProps; brand: Brand }> = ({ scene, brand }) => {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 200 } })
  const shot = scene.shots[0]
  const vertical = height > width
  return (
    <AbsoluteFill
      style={{
        background: brand.background,
        color: brand.text,
        alignItems: 'center',
        justifyContent: vertical ? 'center' : 'flex-start',
        padding: vertical ? '120px 60px 380px' : '90px 120px 240px',
        gap: 48,
      }}
    >
      <AccentGlow color={brand.accent} size={900} opacity={0.25} position="top" />
      <div
        style={{
          fontSize: vertical ? 72 : 64,
          fontWeight: 800,
          letterSpacing: -1.5,
          textAlign: 'center',
          lineHeight: 1.1,
          maxWidth: 1500,
          opacity: enter,
          transform: `translateY(${interpolate(enter, [0, 1], [30, 0])}px)`,
        }}
      >
        {scene.headline}
      </div>
      {shot && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            width: '100%',
            display: 'flex',
            justifyContent: 'center',
            opacity: enter,
            transform: `scale(${interpolate(enter, [0, 1], [0.94, 1])})`,
          }}
        >
          <Screenshot
            shot={shot}
            style={{ width: 'auto', maxWidth: '100%', boxShadow: '0 40px 120px rgba(0,0,0,0.35)' }}
          />
        </div>
      )}
    </AbsoluteFill>
  )
}
