import { loadFont as loadGeist } from '@remotion/google-fonts/Geist'
import { loadFont as loadGeistMono } from '@remotion/google-fonts/GeistMono'
import { loadFont as loadInter } from '@remotion/google-fonts/Inter'
import { loadFont as loadJetBrainsMono } from '@remotion/google-fonts/JetBrainsMono'

/**
 * Load the marketing-video font stack at bundle entry. Calls are
 * idempotent — the first one fires the network fetch + injects @font-face,
 * subsequent ones are no-ops. We pre-load all three weights we use so
 * the first render frame doesn't fall back to Times.
 *
 * Exposed names:
 *   geist       — UI / body / large display
 *   geistMono   — code / terminal lines
 *   inter       — fallback if a project's brand font is undefined
 *   jetBrainsMono — alternative monospace (slightly more humanist)
 */
export const fonts = {
  geist:         loadGeist('normal',         { weights: ['400', '500', '600', '700', '800'] }),
  geistMono:     loadGeistMono('normal',     { weights: ['400', '500', '700'] }),
  inter:         loadInter('normal',         { weights: ['400', '500', '600', '700', '800'] }),
  jetBrainsMono: loadJetBrainsMono('normal', { weights: ['400', '500'] }),
}
