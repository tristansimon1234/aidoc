/**
 * Shared post-AI validation + recovery for the marketing script.
 *
 * The TSX path means the model writes free `mockCode` for each scene's
 * visual. After Zod parses the script, this module checks each scene
 * has a usable visual: mockCompiledCode, mock (legacy DSL), or a
 * non-null screenshotIndex. If a scene has none of those, we mark it
 * — the FeatureScene's ScreenshotFrame fallback shows a flat bgColor
 * which is the cleanest "blank but on-brand" state.
 *
 * No template normalization here — there are no templates in this
 * architecture. The protective surface lives in mock-code.compiler
 * (lint + esbuild) and in repairMockCode (per-scene rescue retry).
 */

import type { MarketingScene } from './marketing-video.types.js'

/**
 * Walk the script and report scenes with no usable visual. Doesn't
 * mutate (the Remotion-side ScreenshotFrame handles the empty state by
 * rendering branding.bgColor — that's the deterministic safety net).
 *
 * Returns the count of "blank-after-recovery" scenes for log signal.
 * If this is > 0 it means the rescue retries also failed AND the
 * scene wasn't a screenshot scene to begin with.
 */
export function ensureSceneVisuals(scenes: MarketingScene[]): number {
  let blank = 0
  for (const scene of scenes) {
    const hasCompiledMock = !!scene.mockCompiledCode
    const hasScreenshot =
      typeof scene.screenshotIndex === 'number' && scene.screenshotIndex !== null
    if (!hasCompiledMock && !hasScreenshot) {
      blank += 1
    }
  }
  return blank
}
