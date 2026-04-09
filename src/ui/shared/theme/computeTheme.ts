import type { ProjectDesignDTO } from '../api/client.js'

/**
 * Compute CSS var overrides from project design.
 * Only overrides accent (primary) and font — leaves bg/card/border/muted
 * to the system theme (light/dark mode) so dark mode keeps working.
 */
export function computeThemeVars(design: ProjectDesignDTO): React.CSSProperties {
  return {
    '--color-primary': design.accentColor,
    '--color-primary-hover': design.accentColor,
    '--font-sans': design.font,
    '--font-heading': design.font,
  } as React.CSSProperties
}
