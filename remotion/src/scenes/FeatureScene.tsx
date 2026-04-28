import React from 'react'
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { Branding, Scene, Screenshot } from '../manifest.js'
import { BrandWatermark } from './BrandWatermark.js'
import { DynamicMock } from '../mocks/DynamicMock.js'
import { DynamicScene } from './DynamicScene.js'

interface FeatureSceneProps {
  scene: Scene
  screenshot: Screenshot | null
  branding: Branding
  /** 0-based index of this scene in the script. Drives layout variation
   *  so consecutive scenes don't all look the same. */
  sceneIndex: number
}

/**
 * Mid-act scene. Four layout variants cycle by sceneIndex so a 4-scene
 * video doesn't feel like the same shot four times. The text-block and
 * screenshot-block are extracted into shared sub-components — the layout
 * is just where we position them.
 *
 *   index % 4 === 0 → split-left      (text left, screenshot right)
 *   index % 4 === 1 → fullscreen      (screenshot fills frame, text bottom-left overlay)
 *   index % 4 === 2 → split-right     (mirrored: text right, screenshot left)
 *   index % 4 === 3 → stacked         (headline top huge, screenshot below)
 *
 * The screenshot can be null; layouts gracefully fall back to a tinted
 * accent panel so the structure doesn't collapse.
 */
type LayoutVariant = 'split-left' | 'fullscreen' | 'split-right' | 'stacked'
const LAYOUT_CYCLE: LayoutVariant[] = ['split-left', 'fullscreen', 'split-right', 'stacked']

export const FeatureScene: React.FC<FeatureSceneProps> = ({ scene, screenshot, branding, sceneIndex }) => {
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
  const imgOpacity = interpolate(imgIn, [0, 1], [0, 1]) * fadeOut

  // Ken Burns — slow zoom + diagonal pan. Direction varies per scene so
  // a 4-scene video doesn't pan the same way 4 times in a row.
  const kbProgress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  const kbScale = interpolate(kbProgress, [0, 1], [1.0, 1.08])
  const headlineHash = scene.headline.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const kbDirX = (headlineHash % 2 === 0 ? 1 : -1)
  const kbDirY = (Math.floor(headlineHash / 2) % 2 === 0 ? 1 : -1)
  const kbPanX = interpolate(kbProgress, [0, 1], [0, 28 * kbDirX])
  const kbPanY = interpolate(kbProgress, [0, 1], [0, 16 * kbDirY])

  const layout: LayoutVariant = LAYOUT_CYCLE[sceneIndex % LAYOUT_CYCLE.length]!

  // Visual priority for the scene:
  //   1. mockCompiledCode → run the LLM-generated TSX inside the
  //      visual panel, side-by-side with the text block.
  //   2. mock (legacy DSL) → static-ish primitive composition.
  //   3. screenshot → real product UI with Ken Burns.
  // The mock IS the visual element of whatever layout the scene uses
  // (split-left / split-right / fullscreen / stacked). It does NOT
  // consume the whole canvas — text panel always coexists.
  const visualElement = scene.mockCompiledCode ? (
    <DynamicScene mockCompiledCode={scene.mockCompiledCode} branding={branding} />
  ) : scene.mock ? (
    <DynamicMock mock={scene.mock} branding={branding} width={920} height={580} />
  ) : (
    <ScreenshotFrame
      screenshot={screenshot}
      branding={branding}
      kbScale={kbScale}
      kbPanX={kbPanX}
      kbPanY={kbPanY}
    />
  )

  const textBlock = (alignment: 'left' | 'right' | 'center') => (
    <TextBlock
      scene={scene}
      branding={branding}
      alignment={alignment}
      headlineY={headlineY}
      headlineOpacity={headlineOpacity}
    />
  )

  return (
    <AbsoluteFill style={{ backgroundColor: branding.bgColor, overflow: 'hidden' }}>
      <BrandWatermark branding={branding} position="top-right" size={56} />

      {layout === 'split-left' && (
        <>
          <AbsoluteFill style={{ background: `radial-gradient(ellipse at 80% 50%, ${branding.accentColor}22 0%, transparent 65%)`, opacity: fadeOut }} />
          <div style={{ position: 'absolute', left: 100, top: 0, bottom: 0, width: 720, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            {textBlock('left')}
          </div>
          <div style={{ position: 'absolute', right: 100, top: '50%', width: 920, height: 580, marginTop: -290, opacity: imgOpacity, transform: `translateX(${interpolate(imgIn, [0, 1], [80, 0])}px)` }}>
            {visualElement}
          </div>
        </>
      )}

      {layout === 'split-right' && (
        <>
          <AbsoluteFill style={{ background: `radial-gradient(ellipse at 20% 50%, ${branding.accentColor}22 0%, transparent 65%)`, opacity: fadeOut }} />
          <div style={{ position: 'absolute', right: 100, top: 0, bottom: 0, width: 720, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            {textBlock('right')}
          </div>
          <div style={{ position: 'absolute', left: 100, top: '50%', width: 920, height: 580, marginTop: -290, opacity: imgOpacity, transform: `translateX(${interpolate(imgIn, [0, 1], [-80, 0])}px)` }}>
            {visualElement}
          </div>
        </>
      )}

      {layout === 'fullscreen' && (
        <>
          {/* Screenshot fills the frame; the text sits bottom-left over a
              backdrop-blur scrim so it stays legible regardless of the
              underlying image colors. */}
          <AbsoluteFill style={{ opacity: imgOpacity, padding: 80 }}>
            <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 24, overflow: 'hidden' }}>
              {visualElement}
            </div>
          </AbsoluteFill>
          <div
            style={{
              position: 'absolute',
              left: 120,
              right: 120,
              bottom: 120,
              maxWidth: 1100,
              padding: '36px 44px',
              borderRadius: 20,
              background: `${branding.bgColor}D9`,
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: `1px solid ${branding.textColor}1A`,
              boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
            }}
          >
            {textBlock('left')}
          </div>
        </>
      )}

      {layout === 'stacked' && (
        <>
          <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 0%, ${branding.accentColor}22 0%, transparent 60%)`, opacity: fadeOut }} />
          <div style={{ position: 'absolute', top: 80, left: 120, right: 120, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
            {textBlock('center')}
          </div>
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 80,
              width: 1280,
              height: 580,
              marginLeft: -640,
              opacity: imgOpacity,
              transform: `translateY(${interpolate(imgIn, [0, 1], [60, 0])}px)`,
            }}
          >
            {visualElement}
          </div>
        </>
      )}
    </AbsoluteFill>
  )
}

interface TextBlockProps {
  scene: Scene
  branding: Branding
  alignment: 'left' | 'right' | 'center'
  headlineY: number
  headlineOpacity: number
}

const TextBlock: React.FC<TextBlockProps> = ({ scene, branding, alignment, headlineY, headlineOpacity }) => {
  // Centered layouts use a smaller headline so a long line wraps nicely
  // inside the canvas instead of bleeding off the sides.
  const headlineSize = alignment === 'center' ? 84 : 92
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: alignment === 'right' ? 'flex-end' : alignment === 'center' ? 'center' : 'flex-start',
        gap: 20,
        opacity: headlineOpacity,
        transform: `translateY(${headlineY}px)`,
        textAlign: alignment,
        width: '100%',
      }}
    >
      <div
        style={{
          padding: '6px 14px',
          borderRadius: 999,
          background: `${branding.accentColor}25`,
          color: branding.accentColor,
          fontFamily: `${branding.fontFamily}, system-ui, sans-serif`,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        {branding.productName}
      </div>
      <h2
        style={{
          color: branding.textColor,
          fontFamily: `${branding.fontFamily}, system-ui, sans-serif`,
          fontSize: headlineSize,
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
            fontSize: 30,
            fontWeight: 400,
            lineHeight: 1.35,
            letterSpacing: '-0.005em',
            margin: 0,
            maxWidth: alignment === 'center' ? 1100 : 680,
          }}
        >
          {scene.subhead}
        </p>
      )}
    </div>
  )
}

interface ScreenshotFrameProps {
  screenshot: Screenshot | null
  branding: Branding
  kbScale: number
  kbPanX: number
  kbPanY: number
}

const ScreenshotFrame: React.FC<ScreenshotFrameProps> = ({ screenshot, branding, kbScale, kbPanX, kbPanY }) => {
  return (
    <>
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
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: `scale(${kbScale}) translate(${kbPanX}px, ${kbPanY}px)`,
              transformOrigin: 'center center',
              willChange: 'transform',
            }}
          />
        ) : (
          <AbsoluteFill
            style={{ background: `linear-gradient(135deg, ${branding.accentColor}55, ${branding.bgColor})` }}
          />
        )}
      </div>
    </>
  )
}
