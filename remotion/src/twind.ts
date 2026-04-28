import { install } from '@twind/core'
import presetTailwind from '@twind/preset-tailwind'
import presetAutoprefix from '@twind/preset-autoprefix'

/**
 * Install Twind once at bundle load. This is a runtime Tailwind: any
 * className string we (or LLM-generated mock code) emit gets translated
 * to actual CSS and injected on the fly. No build step, no PurgeCSS
 * problem — every Tailwind utility the LLM might invent is processed
 * the first time it shows up at render time.
 *
 * Why this matters for marketing-video: the LLM was burning chars on
 * inline styles for things Tailwind expresses in 1-3 utility classes
 * (`bg-zinc-950`, `rounded-xl`, `shadow-2xl`, `backdrop-blur-md`).
 * Letting it use className gives ~3-5x more designed surface per char.
 *
 * The install function is idempotent — calling it twice is a no-op.
 * We hash=false so generated class names are stable across renders
 * (helpful when Remotion hot-reloads during preview).
 */
install({
  presets: [presetAutoprefix(), presetTailwind()],
  hash: false,
})
