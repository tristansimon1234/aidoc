# Marketing-video MVP — Remotion

Local-iteration setup for the marketing-video feature. Server-side render is
intentionally out of scope for this PR — we want to validate the *creative*
output (template + script + voice tone) before sinking time into render
infra.

## Quick start

```bash
# 1. Install deps once
npm install

# 2. Open the template with the bundled sample manifest (no backend needed)
npm run remotion:preview

# 3. Generate a real manifest from a runId (calls Gemini + ElevenLabs)
npm run marketing:preview <runId>

# 3b. Iterate the template without burning ElevenLabs credits
npm run marketing:preview <runId> -- --no-voiceover

# 3c. Steer the angle / audience / tone
npm run marketing:preview <runId> -- --prompt "Focus on the AI agent that tests docs. Audience: B2B PMs. Tone: confident, slightly cheeky."

# 4. Render to MP4
npm run remotion:render
# → out/marketing.mp4
```

## How the pieces fit

```
runId
  ↓ scripts/marketing-video.ts
  ↓ calls generateMarketingVideoForRun()
  ↓ writes remotion/manifest.json
remotion/src/Root.tsx
  ↓ loadManifest() reads manifest.json (or falls back to sample)
  ↓ registers <Composition id="MarketingVideo" ...>
remotion/src/MarketingVideo.tsx
  ↓ <Sequence>s: Hook → FeatureScene × N → Cta
  ↓ <Audio src={voiceoverUrl} /> over the whole thing
ffmpeg via @remotion/renderer
  ↓ MP4
```

## Editing the template

Each scene is a self-contained React component under `remotion/src/scenes/`.
Reload is instant in `remotion preview`. Tokens (colors, font) come from the
manifest's `branding` object — same source-of-truth as the in-app
ProjectDesign.

## Server-side render — production path

Vercel serverless functions can't host Chromium (~170 MB), so production
renders go through the standalone video-service that already runs ffmpeg
jobs. Doclee calls it via `renderMarketingVideo()` in
`src/shared/video/video.client.ts`.

### Distributing the bundle (automatic)

The Vercel `build` script ships the Remotion bundle as a static asset
automatically, so the video-service can fetch it from the same domain as
the Doclee app. Wired via:

```jsonc
// package.json
"scripts": {
  "prebuild": "npm run remotion:bundle && node scripts/copy-remotion-bundle.mjs",
  "build": "tsc && vite build"
}
```

That runs on every `vercel build`:

1. `remotion:bundle` produces `dist/remotion-bundle/`
2. `copy-remotion-bundle.mjs` mirrors it into `public/remotion-bundle/`
3. Vite picks it up and ships it inside `dist/client/remotion-bundle/`
4. Once deployed, it's served at `${PUBLIC_APP_URL}/remotion-bundle/`

The marketing-video service uses that URL by default — no env var needed
beyond `PUBLIC_APP_URL` which you already set. To host the bundle
elsewhere (separate CDN, baked into the video-service image, etc.) set
`REMOTION_SERVE_URL` and Doclee picks that instead.

### Video-service contract

The video-service must implement:

```
POST /render-marketing-video
body: {
  runId: string,
  manifestUrl: string,         // public JSON manifest produced by Doclee
  compositionId: "MarketingVideo",
  remotionServeUrl: string,    // pre-bundled Remotion site (see above)
  fps: 30,
  widthPx: 1920,
  heightPx: 1080
}
→ { videoPath: "runs/<runId>/marketing.mp4" }
```

Server implementation hints:

```ts
import { selectComposition, renderMedia } from '@remotion/renderer'

const inputProps = await fetch(manifestUrl).then((r) => r.json())
const composition = await selectComposition({
  serveUrl: remotionServeUrl,
  id: compositionId,
  inputProps,
})
await renderMedia({
  composition,
  serveUrl: remotionServeUrl,
  codec: 'h264',
  outputLocation: '/tmp/marketing.mp4',
  inputProps,
})
// Upload /tmp/marketing.mp4 to artifacts bucket → return path
```

### Triggering a render from Doclee

```bash
# 1. Generate manifest (script + voice-over)
curl -X POST $DOCLEE_API/api/runs/$RUN_ID/marketing-video \
  -H "Authorization: Bearer $JWT" \
  -d '{"userPrompt": "..."}'

# 2. Render to MP4
curl -X POST $DOCLEE_API/api/runs/$RUN_ID/marketing-video/render \
  -H "Authorization: Bearer $JWT"
# Synchronous — returns once the MP4 lands or the render fails.
```

The render endpoint updates `summary_json.marketingVideo.renderStatus` to
`rendering` while in flight, then `ready` (with `videoUrl`) or `failed`
(with `renderError`).

## Caveats

- **Licensing**: Remotion is free for solo / micro-team. Re-check before
  shipping commercially with multiple devs (Remotion Pro is paid).
- **Voice-over**: ElevenLabs is called once per `marketing:preview` run with
  voice-over enabled (~€0.30). Use `--no-voiceover` while iterating layouts.
- **Render time**: a 60 s 1080p video typically renders in 2-5 min on a
  2-vCPU box. Within Vercel's 300 s function cap. If you exceed it, swap
  the synchronous render call for the async job pattern in
  `src/features/run/job.repository.ts`.
