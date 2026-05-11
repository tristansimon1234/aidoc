/**
 * Normalize an arbitrary `design` object before it hits the DB. Centralizes
 * the rules so every write — through Zod on /api/* or through Supabase RLS
 * direct from the browser via `db.ts` — produces the SAME canonical shape:
 *
 *   - Colors: `#RRGGBB` uppercase via `normalizeHex`, fallback to a safe
 *     default when the input can't be coerced. No `rgb(...)`, no named
 *     colors, no alpha.
 *   - Font: canonical CSS family value from the allowlist via
 *     `resolveFontCssValue`. Bare names like "Inter" get expanded to the
 *     full stack; unknown values fall back to the System default.
 *   - logoUrl: kept only when it's an https Supabase storage URL — same
 *     defense as the Zod schema (stops a tracking-pixel hijack).
 *   - widgetPosition: 'left' or 'right' only.
 *   - Optional brand-kit fields (accentSecondary, radius) cleaned the
 *     same way; missing fields stay missing.
 *
 * Defaults used when a value is invalid:
 *   accentColor → #2563EB · bgColor → #FFFFFF · textColor → #1A1A1A
 * — same defaults the AI auto-fill uses, so a sanitization fallback
 * doesn't suddenly drop the user onto a wildly different palette.
 *
 * Idempotent: feeding a canonical design back in returns the same object
 * shape. Pure function — no I/O, safe to call from both server and
 * client code paths.
 */

import { normalizeHex } from './colors.js'
import { resolveFontCssValue } from './fonts.js'

export interface NormalizedDesign {
  accentColor: string
  bgColor: string
  textColor: string
  font: string
  logoUrl?: string
  widgetPosition?: 'left' | 'right'
  widgetGreeting?: string
  accentSecondary?: string
  radius?: number
}

function safeLogoUrl(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  try {
    const parsed = new URL(input)
    if (parsed.protocol !== 'https:') return undefined
    if (!/\.supabase\.(co|in)$/.test(parsed.hostname)) return undefined
    if (!parsed.pathname.startsWith('/storage/')) return undefined
    return input
  } catch {
    return undefined
  }
}

export function normalizeDesign(input: unknown): NormalizedDesign {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>

  const accentColor = normalizeHex(raw.accentColor) ?? '#2563EB'
  const bgColor = normalizeHex(raw.bgColor) ?? '#FFFFFF'
  const textColor = normalizeHex(raw.textColor) ?? '#1A1A1A'
  const font = resolveFontCssValue(raw.font)

  const out: NormalizedDesign = { accentColor, bgColor, textColor, font }

  const logoUrl = safeLogoUrl(raw.logoUrl)
  if (logoUrl) out.logoUrl = logoUrl

  if (raw.widgetPosition === 'left' || raw.widgetPosition === 'right') {
    out.widgetPosition = raw.widgetPosition
  }
  if (typeof raw.widgetGreeting === 'string' && raw.widgetGreeting.trim()) {
    out.widgetGreeting = raw.widgetGreeting.slice(0, 200)
  }

  const accentSecondary = normalizeHex(raw.accentSecondary)
  if (accentSecondary) out.accentSecondary = accentSecondary

  if (typeof raw.radius === 'number' && raw.radius >= 0 && raw.radius <= 64) {
    out.radius = Math.round(raw.radius)
  }

  return out
}
