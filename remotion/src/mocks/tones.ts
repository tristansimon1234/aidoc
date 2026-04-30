import type { Branding, MockTone } from '../manifest.js'

/**
 * Resolve a logical tone (`accent` / `success` / `muted` / etc.) into
 * concrete colors that respect the project's branding AND the surrounding
 * frame tone (dark vs light).
 *
 * Why this exists: the LLM emits tone names in the DSL (it shouldn't be
 * picking hex codes), and the Remotion components need both a foreground
 * and a background swatch (e.g. for pills) per tone. Centralising the
 * mapping keeps every primitive consistent.
 */
export interface ToneColors {
  fg: string
  bg: string
}

export function resolveTone(
  tone: MockTone | undefined,
  branding: Branding,
  frameTone: 'light' | 'dark' = 'light',
): ToneColors {
  const accent = branding.accentColor
  const isDark = frameTone === 'dark'
  switch (tone) {
    case 'accent':
      return { fg: accent, bg: `${accent}25` }
    case 'success':
      return { fg: '#22C55E', bg: '#22C55E25' }
    case 'warning':
      return { fg: '#F59E0B', bg: '#F59E0B25' }
    case 'danger':
      return { fg: '#EF4444', bg: '#EF444425' }
    case 'muted':
      return isDark
        ? { fg: '#FFFFFF60', bg: '#FFFFFF12' }
        : { fg: '#71717A',   bg: '#F4F4F5' }
    case 'default':
    default:
      return isDark
        ? { fg: '#FFFFFFE6', bg: '#FFFFFF12' }
        : { fg: '#18181B',   bg: '#F4F4F5' }
  }
}

/** The frame's own surface colors. Used by MockFrame chrome and as a
 *  fallback background when a primitive has no tone. */
export function frameSurface(frameTone: 'light' | 'dark' = 'light'): {
  bg: string
  border: string
  chromeBg: string
  chromeFg: string
} {
  return frameTone === 'dark'
    ? {
        bg:       '#0B0B0F',
        border:   '#FFFFFF18',
        chromeBg: '#16161A',
        chromeFg: '#FFFFFF80',
      }
    : {
        bg:       '#FFFFFF',
        border:   '#0000001A',
        chromeBg: '#F8FAFC',
        chromeFg: '#52525B',
      }
}
