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
// PNG instead of JPEG: lossless intermediate frames mean the final MP4
// shows crisp typography, sharp borders, no JPEG blocking around the
// browser-frame chrome / pill borders / chart strokes. Render time goes
// up ~25% but the output reads as "designed" instead of "compressed".
Config.setVideoImageFormat('png')
Config.setOverwriteOutput(true)
Config.setConcurrency(null)
Config.setCodec('h264')
