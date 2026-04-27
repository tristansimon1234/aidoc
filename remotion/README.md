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

## Caveats

- **Licensing**: Remotion is free for solo / micro-team. Re-check before
  shipping commercially with multiple devs (Remotion Pro is paid).
- **Voice-over**: ElevenLabs is called once per `marketing:preview` run with
  voice-over enabled (~€0.30). Use `--no-voiceover` while iterating layouts.
- **Server render**: not in this PR. Next iteration: extend the existing
  video-service with `@remotion/renderer`, or wire up Remotion Lambda.
