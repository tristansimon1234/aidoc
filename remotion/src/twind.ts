import { install } from '@twind/core'
import presetTailwind from '@twind/preset-tailwind'
import presetAutoprefix from '@twind/preset-autoprefix'

/**
 * Install Twind once at bundle load. This is a runtime Tailwind: any
 * className string we (or LLM-generated mock code) emit gets translated
 * to actual CSS and injected on the fly.
 *
 * font-sans / font-mono overridden so the default Tailwind stacks
 * point at the webfonts we load via @remotion/google-fonts (Geist for
 * sans, Geist Mono / JetBrains Mono for mono). Without this, every
 * `className='text-2xl'` falls back to the system font even though we
 * pre-loaded Geist — the LLM ends up with mixed typography.
 *
 * The install function is idempotent — calling it twice is a no-op.
 * hash=false so generated class names are stable across renders.
 */
install({
  presets: [presetAutoprefix(), presetTailwind()],
  hash: false,
  theme: {
    extend: {
      fontFamily: {
        // Reads the project's --brand-font CSS variable set by FeatureScene
        // per-render (so Tailwind's font-sans / default text-* classes
        // honour the project's branding.fontFamily). Falls through to
        // Geist (loaded webfont) → Inter → system-ui if the project
        // didn't set a custom font.
        sans:  ['var(--brand-font)', 'Geist',       'Inter',          'system-ui',                            'sans-serif'],
        mono:  ['Geist Mono',         'JetBrains Mono', 'ui-monospace', 'SFMono-Regular',                      'monospace'],
        serif: ['ui-serif',           'Georgia',                                                              'serif'],
      },
    },
  },
})

// Inject a global rule so even non-Tailwind text (the bundled chrome
// traffic-light dots' invisible spans, the URL bar, etc.) inherits
// Geist by default. Without this, the chrome inherits whatever the
// browser's default is and the contrast vs. Tailwind-styled content
// is jarring.
if (typeof document !== 'undefined') {
  const style = document.createElement('style')
  style.textContent = `
    html, body, #root, #__remotion-studio-container {
      font-family: 'Geist', 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
  `
  document.head.appendChild(style)
}
