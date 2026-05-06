import React from 'react'
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { Branding, Scene, Screenshot } from '../manifest.js'
import { BrandWatermark } from './BrandWatermark.js'
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
 * Mid-act scene. Three layout variants cycle by sceneIndex so a 4-scene
 * video doesn't feel like the same shot repeated. The text-block and
 * visual-block are extracted into shared sub-components — the layout
 * is just where we position them.
 *
 *   index % 3 === 0 → split-left   (text left, visual right)
 *   index % 3 === 1 → split-right  (mirrored: text right, visual left)
 *   index % 3 === 2 → stacked      (headline top, visual below)
 *
 * Opt-out: set `scene.headlinePanel = false` to skip the headline panel
 * entirely — the mock then fills the full 1920×1080 canvas and the
 * voice-over carries the narrative. Use for a cinematic single-visual
 * beat where on-screen copy would compete with the mock. `framing` is
 * an orthogonal concern (cadrage of the mock itself: browser / mobile
 * / terminal / fullbleed / split); keep them separate so a
 * `headlinePanel: false` mock can still pick whatever cadrage fits.
 *
 * The previous "fullscreen" variant (visual fills the canvas, text in
 * a backdrop-blur card on top) is dropped — overlaying a glass card on
 * a busy product screenshot produced a visually cluttered result the
 * user described as "horrible". The three remaining layouts all
 * cleanly separate text from visual.
 *
 * The screenshot can be null; layouts gracefully fall back to a tinted
 * accent panel so the structure doesn't collapse.
 */
type LayoutVariant = 'split-left' | 'split-right' | 'stacked' | 'fullbleed-total'
const LAYOUT_CYCLE: LayoutVariant[] = ['split-left', 'split-right', 'stacked']

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

  // headlinePanel === false → caller wants the mock to own the whole
  // canvas and the voice-over to carry the narrative. We skip the
  // headline panel and let the visual element fill 1920×1080. Useful
  // for a "single cinematic shot" beat where any on-screen copy would
  // compete with the mock for attention. Default is true (current
  // three-variant layout).
  //
  // `framing === 'fullbleed-total'` stays accepted as a legacy alias
  // for the same effect — one early caller used it before we settled
  // on the explicit boolean. New callers should pass `headlinePanel`.
  const headlinePanelOff =
    scene.headlinePanel === false || scene.framing === 'fullbleed-total'
  const layout: LayoutVariant = headlinePanelOff
    ? 'fullbleed-total'
    : LAYOUT_CYCLE[sceneIndex % LAYOUT_CYCLE.length]!

  // Visual priority for the scene:
  //   1. template → structured JSON, fixed React component (preferred).
  // Visual routing:
  //   1. mockCompiledCode → DynamicScene runs the LLM-written TSX in
  //      a sandboxed Function with React + Remotion + branding bound.
  //      ALL the protective infra (lint, Proxy Icons, runtime fallback,
  //      per-scene rescue) lives upstream so we trust the compiled code
  //      reaching here is either valid or the SafeMockBoundary will
  //      catch a runtime throw and show a clean canvas.
  //   2. screenshot → real product UI with Ken Burns.
  //   3. nothing → ScreenshotFrame with screenshot=null falls back to
  //      a flat bgColor canvas (handled in ScreenshotFrame itself).
  const visualElement = scene.mockCompiledCode ? (
    <DynamicScene mockCompiledCode={scene.mockCompiledCode} branding={branding} />
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

  // Skip the FeatureScene's ambient radial-gradient when a mock is in
  // play. The mock's own AccentGlow already provides the depth — adding
  // a second large gradient on the canvas paints a visible tinted
  // rectangle on one half ("le carré"), breaking the clean white look.
  // Screenshots still get the gradient (it adds nice ambient where the
  // raw screenshot has none).
  // Skip the FeatureScene's ambient radial-gradient when a mock is in
  // play — the LLM-written TSX produces its own visual surface and a
  // second gradient on the canvas just dirties the white space.
  const usingMock = !!scene.mockCompiledCode

  // Expose the project's font as a CSS custom property so Twind's
  // font-sans utility (used by every Tailwind text-* className inside
  // LLM-generated mocks) resolves to it first. Geist remains the
  // webfont fallback if the project didn't set a custom stack.
  const outerStyle: React.CSSProperties = {
    backgroundColor: branding.bgColor,
    overflow: 'hidden',
    ...({ '--brand-font': branding.fontFamily } as Record<string, string>),
  }

  return (
    <AbsoluteFill style={outerStyle}>
      <BrandWatermark branding={branding} position="top-right" size={56} />

      {layout === 'split-left' && (
        <>
          {!usingMock && <AbsoluteFill style={{ background: `radial-gradient(ellipse at 80% 50%, ${branding.accentColor}22 0%, transparent 65%)`, opacity: fadeOut }} />}
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
          {!usingMock && <AbsoluteFill style={{ background: `radial-gradient(ellipse at 20% 50%, ${branding.accentColor}22 0%, transparent 65%)`, opacity: fadeOut }} />}
          <div style={{ position: 'absolute', right: 100, top: 0, bottom: 0, width: 720, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            {textBlock('right')}
          </div>
          <div style={{ position: 'absolute', left: 100, top: '50%', width: 920, height: 580, marginTop: -290, opacity: imgOpacity, transform: `translateX(${interpolate(imgIn, [0, 1], [-80, 0])}px)` }}>
            {visualElement}
          </div>
        </>
      )}

      {layout === 'stacked' && (
        <>
          {!usingMock && <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 0%, ${branding.accentColor}22 0%, transparent 60%)`, opacity: fadeOut }} />}
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

      {layout === 'fullbleed-total' && (
        <AbsoluteFill style={{ opacity: imgOpacity }}>
          {visualElement}
        </AbsoluteFill>
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
          fontFamily: `${branding.fontFamily}, 'Geist', system-ui, sans-serif`,
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
          fontFamily: `${branding.fontFamily}, 'Geist', system-ui, sans-serif`,
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
            fontFamily: `${branding.fontFamily}, 'Geist', system-ui, sans-serif`,
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
          // No screenshot AND no mock — this is the silent-failure state
          // (mocks-mode scene whose mockCode was missing or both rescue
          // attempts failed). Render just the canvas bgColor so the
          // empty visual slot blends with the rest of the video instead
          // of flashing a colored gradient that looks like a glitch.
          <AbsoluteFill style={{ background: branding.bgColor }} />
        )}
      </div>
    </>
  )
}
