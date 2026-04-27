import { Config } from '@remotion/cli/config'

/**
 * Remotion config for the marketing-video MVP.
 *
 * - Codec H.264 + AAC for the widest compat (Twitter, YouTube, Instagram).
 * - Image format JPEG keeps the on-disk frame cache small during preview;
 *   final renders pick up the codec setting above.
 * - Concurrency null = let Remotion pick (cores - 1).
 *
 * The composition itself lives in `remotion/src/Root.tsx` and is registered
 * with the ID "MarketingVideo" so CLI calls can target it by name.
 */
Config.setVideoImageFormat('jpeg')
Config.setOverwriteOutput(true)
Config.setConcurrency(null)
Config.setCodec('h264')
