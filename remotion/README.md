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

### Distributing the bundle

The video-service needs the **same** Remotion compositions Doclee shipped.
Build them with:

```bash
npm run remotion:bundle
# → dist/remotion-bundle/
```

Then expose that directory over HTTP. Three options, pick whichever fits:

| Option | How | Pros | Cons |
| --- | --- | --- | --- |
| Vercel public asset | Copy `dist/remotion-bundle/` into `public/` before `vercel build`; serve at `${PUBLIC_APP_URL}/remotion-bundle/` | Single deploy, no extra infra | Bundle re-deploys with Doclee app |
| Supabase Storage | Upload bundle to a public bucket; video-service downloads + unzips on demand | Decoupled deploys, cacheable | Extra plumbing, cold-start cost |
| Bake into Docker image | `COPY` into the video-service image at build time | Fastest renders | Doclee + video-service deploys coupled |

Set the resulting URL in `REMOTION_SERVE_URL` on the Doclee env (Vercel
project settings). The service falls back to `${PUBLIC_APP_URL}/remotion-bundle`
when the explicit var is missing.

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
