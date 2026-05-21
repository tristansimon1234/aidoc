/**
 * Font allowlist — single source of truth for "which fonts can a project
 * be configured with". Two categories:
 *   - SYSTEM_FONTS: native CSS stacks, no network fetch needed.
 *   - GOOGLE_FONTS: curated subset of Google Fonts. Adding a font here is
 *     the ONLY way it becomes selectable — both server (Zod) and client
 *     (picker) read from this same list.
 *
 * Why an allowlist (and not "any Google Font name"):
 * - The font name flows into a `<link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=$NAME...'>`.
 *   `encodeURIComponent` already blocks the obvious URL-break attacks, but a
 *   wide-open input still lets an attacker shape the URL Google receives
 *   (cache poisoning, parameter pollution via Unicode tricks, exotic names
 *   triggering 4xx and disabling the page's typography in a noisy way).
 * - The font name ALSO ends up in inline `style.fontFamily` values across
 *   the widget, marketing video, and public docs. React's serializer is
 *   safe, but template-literal CSS strings elsewhere (e.g. server-rendered
 *   manifest JSON consumed by Remotion `style="font-family: ${X}"`) are
 *   not — a CSS-injection-friendly name would be a problem.
 * - With an allowlist the picker stays curated (better UX) and the
 *   security argument collapses to "is the list of names safe?" — which
 *   it trivially is.
 *
 * To add a font: pick the canonical Google Fonts name (the exact label on
 * https://fonts.google.com/specimen/XYZ — case, spaces and all), append it
 * to GOOGLE_FONTS below. No client cache to bust; the picker reads at
 * runtime.
 */

export interface FontOption {
  /** Display label shown in the picker. */
  label: string
  /** The full CSS `font-family` value stored on the project. */
  cssValue: string
  /** Category used for grouping in the picker UI. */
  category: 'system' | 'sans' | 'serif' | 'mono' | 'display'
  /** When set, the picker loads it from Google Fonts via the safe URL
   *  builder before previewing. The canonical name MUST match the
   *  Google Fonts catalog exactly (case-sensitive). */
  googleName?: string
}

export const SYSTEM_FONTS: FontOption[] = [
  {
    label: 'System',
    cssValue: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    category: 'system',
  },
  {
    label: 'Serif (system)',
    cssValue: 'Georgia, "Times New Roman", serif',
    category: 'serif',
  },
  {
    label: 'Mono (system)',
    cssValue: 'ui-monospace, "SF Mono", Menlo, monospace',
    category: 'mono',
  },
]

/** Curated Google Fonts. Each entry is the canonical name from the Google
 *  Fonts catalog. The picker labels and the CSS family string are derived
 *  from this name via `buildCssFamily()` — no duplication. */
const GOOGLE_FONT_NAMES: ReadonlyArray<{ name: string; category: FontOption['category'] }> = [
  // Sans (most common modern UI choices)
  { name: 'Inter', category: 'sans' },
  { name: 'Roboto', category: 'sans' },
  { name: 'Open Sans', category: 'sans' },
  { name: 'Lato', category: 'sans' },
  { name: 'Poppins', category: 'sans' },
  { name: 'Montserrat', category: 'sans' },
  { name: 'DM Sans', category: 'sans' },
  { name: 'Plus Jakarta Sans', category: 'sans' },
  { name: 'Manrope', category: 'sans' },
  { name: 'Outfit', category: 'sans' },
  { name: 'Work Sans', category: 'sans' },
  { name: 'Space Grotesk', category: 'sans' },
  { name: 'Figtree', category: 'sans' },
  { name: 'Onest', category: 'sans' },
  { name: 'Nunito', category: 'sans' },
  { name: 'Geist', category: 'sans' },
  { name: 'IBM Plex Sans', category: 'sans' },
  { name: 'Source Sans 3', category: 'sans' },
  // Serif
  { name: 'Playfair Display', category: 'serif' },
  { name: 'Merriweather', category: 'serif' },
  { name: 'Lora', category: 'serif' },
  { name: 'EB Garamond', category: 'serif' },
  { name: 'Crimson Text', category: 'serif' },
  { name: 'Source Serif 4', category: 'serif' },
  { name: 'IBM Plex Serif', category: 'serif' },
  // Mono
  { name: 'JetBrains Mono', category: 'mono' },
  { name: 'Fira Code', category: 'mono' },
  { name: 'IBM Plex Mono', category: 'mono' },
  { name: 'Geist Mono', category: 'mono' },
  // Display (occasional brand voice)
  { name: 'Bricolage Grotesque', category: 'display' },
  { name: 'Fraunces', category: 'display' },
]

const NAME_RE = /^[A-Za-z][A-Za-z0-9 ]{0,40}$/

/** Build the canonical CSS `font-family` value for a Google Font name.
 *  Adds a sensible fallback in the same category so an in-flight Google
 *  Fonts request never leaves the page rendering in `serif`. */
function buildCssFamily(name: string, category: FontOption['category']): string {
  const fallback =
    category === 'serif' ? 'Georgia, "Times New Roman", serif'
    : category === 'mono' ? 'ui-monospace, "SF Mono", Menlo, monospace'
    : category === 'display' ? '"Inter", system-ui, sans-serif'
    : 'system-ui, -apple-system, sans-serif'
  return `"${name}", ${fallback}`
}

export const GOOGLE_FONTS: FontOption[] = GOOGLE_FONT_NAMES.map(({ name, category }) => ({
  label: name,
  cssValue: buildCssFamily(name, category),
  category,
  googleName: name,
}))

/** Every font the user can pick — system + Google. */
export const ALL_FONTS: FontOption[] = [...SYSTEM_FONTS, ...GOOGLE_FONTS]

/** Lookup by canonical Google Fonts name. Case-sensitive — names ARE the key. */
export function findGoogleFont(name: string): FontOption | null {
  return GOOGLE_FONTS.find((f) => f.googleName === name) ?? null
}

/** Extract the primary font name from a CSS font-family value — the part
 *  before the first comma, stripped of surrounding quotes. Returns null
 *  for empty / non-string input. */
function primaryFontName(cssValue: string): string | null {
  if (typeof cssValue !== 'string') return null
  const head = cssValue.split(',')[0]?.trim()
  if (!head) return null
  return head.replace(/^["']|["']$/g, '').trim()
}

/** Lookup by stored CSS family value. Forgiving across fallback-chain
 *  variations: matches if either (a) the full CSS value is identical to
 *  an allowlist entry, OR (b) the PRIMARY font name (first family in the
 *  stack) matches an allowlist entry's primary name. This lets legacy
 *  records like `"Inter", sans-serif` resolve to the modern catalog
 *  entry `"Inter", system-ui, -apple-system, sans-serif` without forcing
 *  a data migration. Returns null when nothing matches — caller falls
 *  back to System. */
export function findByCssValue(cssValue: string): FontOption | null {
  const target = cssValue.trim().toLowerCase()
  const exact = ALL_FONTS.find((f) => f.cssValue.trim().toLowerCase() === target)
  if (exact) return exact
  const targetPrimary = primaryFontName(cssValue)?.toLowerCase() ?? null
  if (!targetPrimary) return null
  return (
    ALL_FONTS.find((f) => primaryFontName(f.cssValue)?.toLowerCase() === targetPrimary) ?? null
  )
}

/** Is this CSS family value one we accept? Server-side enforcement. */
export function isAllowedFontFamily(cssValue: string): boolean {
  return findByCssValue(cssValue) !== null
}

/**
 * Build a safe Google Fonts stylesheet URL for a font name. Returns null
 * when the name isn't in the allowlist OR doesn't match the strict name
 * regex — the caller must NOT inject the URL into a `<link>` if null comes
 * back. The protocol + host are hardcoded; only the family path-component
 * is variable, and it's encoded.
 */
export function googleFontStylesheetUrl(name: string): string | null {
  if (!NAME_RE.test(name)) return null
  if (!findGoogleFont(name)) return null
  const family = encodeURIComponent(name)
  return `https://fonts.googleapis.com/css2?family=${family}:wght@300;400;500;600;700&display=swap`
}

/** Default font used when nothing is set / something invalid was stored. */
export const DEFAULT_FONT: FontOption = SYSTEM_FONTS[0]!

/** Resolve any font input (canonical CSS value, bare Google Fonts name,
 *  legacy `'"Inter", sans-serif'`) to a canonical CSS value from the
 *  allowlist. Returns DEFAULT_FONT.cssValue when nothing matches — caller
 *  doesn't have to handle null. Used by the project-creation client-side
 *  normalizer so we never persist a hand-shaped CSS family string. */
export function resolveFontCssValue(input: unknown): string {
  if (typeof input !== 'string') return DEFAULT_FONT.cssValue
  const trimmed = input.trim()
  if (!trimmed) return DEFAULT_FONT.cssValue
  // Direct allowlist hit (full CSS value or primary-name match).
  const direct = findByCssValue(trimmed)
  if (direct) return direct.cssValue
  // Bare Google Fonts name like "Inter" or "DM Sans".
  const byName = findGoogleFont(trimmed)
  if (byName) return byName.cssValue
  return DEFAULT_FONT.cssValue
}
