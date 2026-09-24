import React from 'react'
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion'
import type { Brand, CaptionWord } from './props.js'

/** Mots affichés ensemble : une courte ligne, coupée à la fin d'une phrase ou tous les 6 mots. */
function pages(words: CaptionWord[]): CaptionWord[][] {
  const out: CaptionWord[][] = []
  let page: CaptionWord[] = []
  for (const w of words) {
    const gap = page.length > 0 && w.startMs - page[page.length - 1]!.endMs > 400
    if (page.length > 0 && (page.length >= 6 || gap)) {
      out.push(page)
      page = []
    }
    page.push(w)
    if (/[.!?]$/.test(w.text)) {
      out.push(page)
      page = []
    }
  }
  if (page.length > 0) out.push(page)
  return out
}

/** Sous-titres mot à mot, le mot prononcé est surligné (dans le bas de l'image, zone réservée). */
export const Captions: React.FC<{ words: CaptionWord[]; brand: Brand }> = ({ words, brand }) => {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()
  const all = React.useMemo(() => pages(words), [words])
  const ms = (frame / fps) * 1000
  const page = all.find((p) => ms >= p[0]!.startMs - 50 && ms <= p[p.length - 1]!.endMs + 250)
  if (!page) return null
  const vertical = height > width
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingBottom: vertical ? 260 : 70,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          maxWidth: vertical ? 900 : 1500,
          textAlign: 'center',
          fontSize: vertical ? 64 : 54,
          fontWeight: 800,
          lineHeight: 1.25,
          color: '#FFFFFF',
          padding: '14px 28px',
          borderRadius: 18,
          background: 'rgba(0,0,0,0.55)',
          textShadow: '0 2px 8px rgba(0,0,0,0.5)',
        }}
      >
        {page.map((w, i) => {
          const active = ms >= w.startMs && ms < w.endMs
          return (
            <span key={i} style={{ color: active ? brand.accent2 : '#FFFFFF' }}>
              {i > 0 ? ' ' : ''}
              {w.text}
            </span>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}
