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
    const sceneObj = scene as Record<string, unknown>
    const t = sceneObj.template
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

  // Second pass: any template still missing REQUIRED fields after the
  // rename step gets nuked and replaced with a hero-text fallback derived
  // from the scene's headline. This is the most aggressive layer of
  // recovery — better to ship a clean hero-text than fail the whole
  // script because one scene picked a wrong template kind (e.g.
  // "list-reveal" with a `value` slot instead of `items`).
  // Without this, a single broken scene takes down the entire
  // generation: Zod fails on the discriminated-union check and the
  // pipeline aborts.
  const REQUIRED_BY_KIND: Record<string, string[]> = {
    'hero-text':       ['headline'],
    'kpi-reveal':      ['metric', 'value'],
    'list-reveal':     ['title', 'items'],
    'mock-frame':      ['cards'],
    'chat-bubble':     ['question', 'answer'],
    'flow-diagram':    ['nodes'],
    'chart':           ['type', 'points'],
    'before-after':    ['beforeLabel', 'afterLabel'],
    'comparison-bars': ['leftLabel', 'rightLabel', 'rows'],
    'quote':           ['text', 'author'],
    'step-progression':['steps'],
    'big-stat':        ['value'],
    'live-typing':     ['lines'],
    'dual-screen':     ['leftCards', 'rightCards'],
  }
  const isEmpty = (v: unknown): boolean => {
    if (v === undefined || v === null) return true
    if (typeof v === 'string' && v.trim().length === 0) return true
    if (Array.isArray(v) && v.length === 0) return true
    return false
  }
  for (const scene of scenes) {
    if (!scene || typeof scene !== 'object') continue
    const sceneObj = scene as Record<string, unknown>
    const t = sceneObj.template
    if (!t || typeof t !== 'object') continue
    const template = t as Record<string, unknown>
    const kind = template.kind
    if (typeof kind !== 'string') continue
    const required = REQUIRED_BY_KIND[kind]
    if (!required) {
      // Unknown kind — replace with hero-text fallback so Zod doesn't
      // fail on discriminated-union match.
      const headline = typeof sceneObj.headline === 'string' ? sceneObj.headline : 'Highlight'
      sceneObj.template = { kind: 'hero-text', headline, layout: 'burst' }
      continue
    }
    const missing = required.filter((f) => isEmpty(template[f]))
    if (missing.length > 0) {
      const headline = typeof sceneObj.headline === 'string' ? sceneObj.headline : 'Highlight'
      sceneObj.template = { kind: 'hero-text', headline, layout: 'burst' }
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
