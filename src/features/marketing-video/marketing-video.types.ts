/**
 * Marketing-video MVP — turns a documented page into a 60s 16:9 marketing
 * video. The backend produces a manifest (script + voice-over URL +
 * screenshot URLs + branding); Remotion consumes the manifest at the project
 * root to render the actual MP4. Server-side rendering is intentionally out
 * of scope for the MVP — we want to validate the *creative* output (template
 * quality, script tone, screenshot timing) before sinking time into render
 * infra.
 */

export type MarketingScene = {
  /** Plain text the narrator says during this scene. ElevenLabs reads this
   *  verbatim — keep it short, punchy, no audio tags (the marketing voice
   *  preset stays clean). */
  voiceover: string
  /** Big on-screen headline (3-7 words). Animated in. */
  headline: string
  /** Optional supporting line under the headline (8-15 words). */
  subhead?: string
  /** Index into manifest.screenshots — which doc screenshot to feature in
   *  this scene. Null = no screenshot, headline-only scene. */
  screenshotIndex: number | null
  /** Duration of this scene in seconds. The Remotion composition uses these
   *  to compute frame ranges so scene timings line up with the voice-over. */
  durationSeconds: number
}

export interface MarketingScript {
  hook: {
    voiceover: string
    headline: string
    durationSeconds: number
  }
  scenes: MarketingScene[]
  cta: {
    voiceover: string
    headline: string
    /** Short button-style label, e.g. "Try Doclee free". */
    buttonLabel: string
    durationSeconds: number
  }
  /** Total target duration — should match sum of scene durations. The
   *  Remotion composition uses this to set total frame count. */
  totalDurationSeconds: number
  /** ISO-639 language code (e.g. "en", "fr") inferred from the source doc.
   *  Used to pick the matching ElevenLabs voice and to keep the script in
   *  the doc's language rather than the UI language. */
  language: string
}

export interface MarketingScreenshot {
  /** Public URL Remotion can fetch directly. */
  url: string
  /** Original step caption — used as alt text and as subtle on-screen
   *  caption when the scene has no explicit subhead. */
  caption: string
}

export interface MarketingBranding {
  productName: string
  /** Hex (#RRGGBB) — drives accent + button + glow effects. */
  accentColor: string
  /** Hex — composition background. */
  bgColor: string
  /** Hex — primary text color. */
  textColor: string
  fontFamily: string
  logoUrl: string | null
}

export interface MarketingManifest {
  /** runId this manifest was generated from. Lets Remotion identify which
   *  manifest is loaded when iterating in preview mode. */
  runId: string
  generatedAt: string
  script: MarketingScript
  screenshots: MarketingScreenshot[]
  branding: MarketingBranding
  /** Public URL to the marketing voice-over MP3. Null when the user opted
   *  out of voice-over (MVP cost-saving flag). */
  voiceoverUrl: string | null
  /** Storage path under the artifacts bucket (for re-hosting / debugging).
   *  Null when there's no voice-over. */
  voiceoverPath: string | null
  /** Optional URL of a background music track to mix under the voice-over.
   *  Null = silent. Sourced from a preset library or a user upload. */
  musicUrl?: string | null
  /** Storage path of an uploaded music file (relative to artifacts bucket).
   *  Distinct from musicUrl: a preset has a URL but no path, an upload has
   *  both. Lets us keep the signed URL fresh on re-render. */
  musicPath?: string | null
  /** Linear volume 0–1 for the music. Defaults to 0.15. */
  musicVolume?: number
}

/** Render lifecycle of the MP4. The manifest can exist without a render
 *  (script + voice-over only), or with a render in any of these states. */
export type MarketingVideoRenderStatus = 'idle' | 'rendering' | 'ready' | 'failed'

export interface MarketingVideoSummary {
  manifest: MarketingManifest
  /** URL to the manifest JSON in artifacts storage — what the video-service
   *  fetches when rendering. Null when the manifest hasn't been persisted to
   *  storage yet. */
  manifestUrl: string | null
  /** URL to the rendered MP4 once a render lands. Null while the manifest
   *  exists but no render has been triggered, or while rendering is in
   *  flight. */
  videoUrl: string | null
  /** Storage path to the rendered MP4. Mirrors videoUrl but lets the
   *  video-service mux the marketing video into other artifacts later
   *  without re-resolving from a public URL. */
  videoPath: string | null
  renderStatus: MarketingVideoRenderStatus
  /** Failure reason when renderStatus is 'failed'. Surface to the user so
   *  they can act (e.g. video-service down, bundle URL stale). */
  renderError: string | null
}

/** Tone preset name. Maps to a tuned (stability, style, similarityBoost)
 *  triplet — see TONE_PRESETS in marketing-video.service.ts for the values. */
export type VoiceTone = 'punchy' | 'calm' | 'playful' | 'serious'

export interface GenerateMarketingVideoOptions {
  /** When false, skip ElevenLabs synthesis. The manifest still includes the
   *  script so Remotion can render a silent preview. Saves €€ during
   *  template iteration. Default: true. */
  withVoiceover?: boolean
  /** Override the ElevenLabs voice. Defaults to the marketing-tone voice. */
  voiceId?: string
  /** Tone preset for the voice-over. Defaults to "punchy" (the previous
   *  hardcoded values). */
  tone?: VoiceTone
  /** Background music track ID — picked from MUSIC_PRESETS. Mutually
   *  exclusive with `musicUploadPath`. Use 'none' to explicitly disable. */
  musicTrackId?: string
  /** Storage path (in artifacts bucket) of a music file the user uploaded
   *  via the signed-upload endpoint. Mutually exclusive with musicTrackId. */
  musicUploadPath?: string
  /** Linear 0–1 volume for the music. Defaults to 0.15. */
  musicVolume?: number
  /** Free-form steering from the user — tells Gemini what angle to take,
   *  who the target audience is, which feature to emphasize, what tone
   *  shift to apply. The doc remains the content source-of-truth; this is
   *  purely a creative brief layered on top.
   *  Example: "Focus on the AI agent that tests your docs. Audience is
   *  technical PMs in B2B SaaS. Tone: confident, slightly cheeky."  */
  userPrompt?: string
}
