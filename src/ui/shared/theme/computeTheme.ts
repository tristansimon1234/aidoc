import type { ProjectDesignDTO } from '../api/client.js'

function hex2rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

function rgb2hex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
}

function mix(c1: string, c2: string, ratio: number): string {
  const [r1, g1, b1] = hex2rgb(c1)
  const [r2, g2, b2] = hex2rgb(c2)
  return rgb2hex(r1 + (r2 - r1) * ratio, g1 + (g2 - g1) * ratio, b1 + (b2 - b1) * ratio)
}

/**
 * Full theme for public-facing pages (docs, widget preview).
 * Overrides ALL CSS vars including bg, card, border, etc.
 */
export function computeFullTheme(design: ProjectDesignDTO): React.CSSProperties {
  const { accentColor: accent, bgColor: bg, textColor: text, font } = design
  return {
    '--color-primary': accent,
    '--color-primary-hover': accent,
    '--color-bg': bg,
    '--color-fg': text,
    '--color-card': mix(bg, text, 0.04),
    '--color-secondary': mix(bg, text, 0.07),
    '--color-border': mix(bg, text, 0.12),
    '--color-muted-fg': mix(text, bg, 0.4),
    '--color-accent': mix(bg, accent, 0.1),
    '--font-sans': font,
    '--font-heading': font,
  } as React.CSSProperties
}
