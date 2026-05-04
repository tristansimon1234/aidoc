/**
 * Shared post-AI validation + recovery for the marketing script.
 *
 * Both the initial generation (`generateMarketingScript`) and the edit
 * path (`editMarketingManifestWithAi`) end up with a parsed Gemini
 * response that has to be:
 *   1. Slot-name normalized (fight model drift between similar
 *      templates, e.g. quote.text vs chat-bubble.answer)
 *   2. Visually complete (every scene must have a template OR a
 *      mockCompiledCode OR a non-null screenshotIndex; otherwise the
 *      Remotion renderer falls back to a blank canvas)
 *
 * Before this module the two paths each had their own inlined logic
 * with subtle drift — one would normalize but not backfill, the other
 * the inverse. Centralised here so any new edge case is fixed once.
 */

import type { MarketingScene, MarketingScript, SceneTemplate } from './marketing-video.types.js'

/**
 * Cheap pre-Zod fixup for the slot-name drift the model produces between
 * similar templates. The discriminated union has 14 kinds and overlapping
 * vocabulary — when the model picks the wrong field name, Zod fails the
 * whole script. Map the obvious typos here so a single drift doesn't
 * kill the generation.
 *
 * Mutates the input. Anything we don't recognize is left alone so Zod
 * can still flag it clearly.
 */
export function normalizeTemplateSlots(parsed: unknown): void {
  if (!parsed || typeof parsed !== 'object') return
  const root = parsed as Record<string, unknown>
  const scenes = root.scenes
  if (!Array.isArray(scenes)) return

  const renameIfMissing = (obj: Record<string, unknown>, target: string, candidates: string[]): void => {
    if (typeof obj[target] === 'string' && obj[target]) return
    for (const c of candidates) {
      if (typeof obj[c] === 'string' && obj[c]) {
        obj[target] = obj[c]
        delete obj[c]
        return
      }
    }
  }

  for (const scene of scenes) {
    if (!scene || typeof scene !== 'object') continue
    const t = (scene as Record<string, unknown>).template
    if (!t || typeof t !== 'object') continue
    const template = t as Record<string, unknown>
    const kind = template.kind
    switch (kind) {
      case 'chat-bubble':
        renameIfMissing(template, 'answer', ['text', 'content', 'message', 'body', 'response'])
        renameIfMissing(template, 'question', ['prompt', 'query', 'userMessage', 'ask'])
        break
      case 'quote':
        renameIfMissing(template, 'text', ['quote', 'body', 'content', 'message'])
        renameIfMissing(template, 'author', ['name', 'by'])
        break
      case 'hero-text':
        renameIfMissing(template, 'headline', ['title', 'heading', 'text'])
        break
      case 'big-stat':
        renameIfMissing(template, 'value', ['number', 'stat', 'metric'])
        break
      case 'kpi-reveal':
        renameIfMissing(template, 'metric', ['label', 'name'])
        break
      case 'live-typing':
        if (!Array.isArray(template.lines) && typeof template.code === 'string') {
          template.lines = (template.code as string).split('\n').slice(0, 8)
          delete template.code
        }
        break
    }
  }
}

/**
 * After Zod validation, walk the script and ensure every scene has
 * SOMETHING to render. Three valid sources:
 *   1. `template` — structured visual (preferred)
 *   2. `mockCompiledCode` — legacy esbuild output
 *   3. `screenshotIndex` set to a non-null number
 *
 * Anything else means the Remotion renderer will fall back to a flat
 * bgColor canvas (= blank panel). To prevent that we synthesize a
 * deterministic `hero-text` template from the scene's headline. The
 * scene reads as a typographic claim instead of disappearing.
 *
 * Mutates the input. Returns the number of scenes that were patched
 * (for log signal).
 */
export function ensureSceneVisuals(scenes: MarketingScene[]): number {
  let patched = 0
  for (const scene of scenes) {
    const hasTemplate = !!scene.template
    const hasCompiledMock = !!scene.mockCompiledCode
    const hasScreenshot =
      typeof scene.screenshotIndex === 'number' && scene.screenshotIndex !== null
    if (hasTemplate || hasCompiledMock || hasScreenshot) continue

    const fallback: SceneTemplate = {
      kind: 'hero-text',
      headline: scene.headline,
      ...(scene.subhead ? { subhead: scene.subhead } : {}),
      layout: 'burst',
    }
    scene.template = fallback
    patched += 1
  }
  return patched
}

/**
 * Convenience wrapper: run normalize → ensureSceneVisuals on a parsed
 * script in a single call. Use BEFORE Zod validation for the normalize
 * pass (it operates on raw JSON), and AFTER Zod for ensureSceneVisuals
 * (it needs typed access to `scene.template`). Caller stages them
 * around its own Zod step.
 */
export function applyAllRecoveries(script: MarketingScript): { patchedVisuals: number } {
  // normalize is intentionally NOT here — it runs on raw parsed JSON
  // before Zod, while this fn runs on already-typed scripts. Keep them
  // separate and let the caller stage them in the right order.
  const patchedVisuals = ensureSceneVisuals(script.scenes)
  return { patchedVisuals }
}
