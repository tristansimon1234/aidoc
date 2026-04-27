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
}

export interface MarketingVideoSummary {
  manifest: MarketingManifest
  /** URL to the manifest JSON in artifacts storage — what Remotion fetches
   *  when running outside of a checked-out manifest.json (e.g. cloud render
   *  later). Null when the manifest hasn't been persisted to storage yet. */
  manifestUrl: string | null
  /** URL to the rendered MP4 once a render lands. Null in the MVP — render
   *  pipeline is a follow-up PR. */
  videoUrl: string | null
}

export interface GenerateMarketingVideoOptions {
  /** When false, skip ElevenLabs synthesis. The manifest still includes the
   *  script so Remotion can render a silent preview. Saves €€ during
   *  template iteration. Default: true. */
  withVoiceover?: boolean
  /** Override the ElevenLabs voice. Defaults to the marketing-tone voice. */
  voiceId?: string
  /** Free-form steering from the user — tells Gemini what angle to take,
   *  who the target audience is, which feature to emphasize, what tone
   *  shift to apply. The doc remains the content source-of-truth; this is
   *  purely a creative brief layered on top.
   *  Example: "Focus on the AI agent that tests your docs. Audience is
   *  technical PMs in B2B SaaS. Tone: confident, slightly cheeky."  */
  userPrompt?: string
}
