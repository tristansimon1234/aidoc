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

function luma(hex: string): number {
  const [r, g, b] = hex2rgb(hex)
  return (r * 299 + g * 587 + b * 114) / 1000
}

/**
 * Compute full CSS variable set from design colors.
 * If `invertForDark` is true and the design bg is light, swap bg↔text
 * so the project looks native in dark mode.
 */
export function computeThemeVars(design: ProjectDesignDTO, invertForDark = false): React.CSSProperties {
  let { accentColor: accent, bgColor: bg, textColor: text, font } = design

  // Invert for dark mode: if design bg is light and we're in dark mode → swap
  if (invertForDark) {
    const bgIsLight = luma(bg) > 128
    if (bgIsLight) {
      const tmp = bg; bg = text; text = tmp
    }
  }

  const bgDark = luma(bg) < 128
  return {
    '--color-primary': accent,
    '--color-primary-hover': accent,
    '--color-bg': bg,
    '--color-fg': text,
    '--color-card': mix(bg, text, 0.04),
    '--color-secondary': mix(bg, text, 0.07),
    '--color-border': mix(bg, text, 0.12),
    '--color-muted-fg': mix(text, bg, 0.4),
    '--color-accent': mix(bg, accent, bgDark ? 0.15 : 0.08),
    '--font-sans': font,
    '--font-heading': font,
  } as React.CSSProperties
}
