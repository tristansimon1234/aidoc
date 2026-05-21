/**
 * Hex color validation + normalization. Single source of truth for "is this
 * a color string we'll accept from a user or AI". Used by:
 *   - project.schema.ts (DesignSchema) — user-submitted brand colors
 *   - marketing-video.schema.ts (Branding) — manifest persistence
 *   - project.routes.ts (analyze-url) — AI auto-fill sanitization
 *
 * Why hex only:
 * - The renderers (CSS, Remotion, ECharts) all accept hex universally.
 * - Hex is trivially safe to interpolate into CSS / SVG attributes; named
 *   colors and rgba() require sanitization to avoid CSS injection when the
 *   value reaches a template literal (e.g. inline `style="..."` strings).
 * - Color pickers (`<input type="color">`) emit hex natively — no UI cost.
 *
 * Accept on input:
 *   - `#RRGGBB`        canonical (preferred)
 *   - `#RGB`           shorthand → expanded
 *   - `RRGGBB` / `RGB` missing `#` → prefixed
 *   - whitespace + any case → trimmed + uppercased
 * Reject:
 *   - `rgb(...)`, `hsl(...)`, `rgba(...)`, named colors, `var(--…)`, anything else.
 *   - 4 / 8-char hex with alpha (alpha lives in opacity / separate field).
 */

import { z } from 'zod'

const HEX_FULL_RE = /^#?[0-9a-fA-F]{6}$/
const HEX_SHORT_RE = /^#?[0-9a-fA-F]{3}$/

/**
 * Normalize any of the accepted forms to `#RRGGBB` (uppercase). Returns null
 * when the input can't be coerced — callers can then fall back to a default
 * or reject. Never throws.
 */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (HEX_FULL_RE.test(trimmed)) {
    return ('#' + trimmed.replace(/^#/, '')).toUpperCase()
  }
  if (HEX_SHORT_RE.test(trimmed)) {
    const body = trimmed.replace(/^#/, '')
    const expanded = body.split('').map((c) => c + c).join('')
    return ('#' + expanded).toUpperCase()
  }
  return null
}

/**
 * Zod schema that requires a canonical `#RRGGBB` hex string. Use this for
 * persistence (the DB shouldn't see anything else). For lenient input that
 * passes through `normalizeHex` first, define a preprocess wrapper at the
 * call site.
 */
export const HexColorSchema = z
  .string()
  .regex(/^#[0-9A-F]{6}$/, 'Must be a #RRGGBB hex color (uppercase)')

/**
 * Lenient version: accepts any of the input forms `normalizeHex` does, and
 * fails Zod validation if the result can't be canonicalized. Use on user-
 * facing routes where we want to be forgiving about case / shorthand /
 * missing `#`, then store the canonical form.
 */
export const LenientHexColorSchema = z.preprocess((v) => normalizeHex(v) ?? v, HexColorSchema)
