/**
 * Marketing-video MVP — turns a documented page into a 60s 16:9 marketing
 * video. The backend produces a manifest (script + voice-over URL +
 * screenshot URLs + branding); Remotion consumes the manifest at the project
 * root to render the actual MP4. Server-side rendering is intentionally out
 * of scope for the MVP — we want to validate the *creative* output (template
 * quality, script tone, screenshot timing) before sinking time into render
 * infra.
 */

/** Tone label that maps to a brand-aware color in the renderer. We keep
 *  this as an enum (vs hex codes from the LLM) so mocks always respect
 *  the project's branding + frame contrast. */
export type MockTone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'danger'

/** Single primitive in the mock DSL. The Remotion-side renderer maps each
 *  one-to-one to a frame-driven React component. Recursive `group` is
 *  intentionally NOT exposed to the LLM (Gemini's responseSchema can't
 *  represent recursion); the layout can be controlled via the top-level
 *  `Mock.layout`. */
export type MockElement =
  | { type: 'header'; label: string; icon?: string; statusText?: string; statusTone?: MockTone; delay?: number }
  | { type: 'terminalLine'; prefix?: string; text: string; tone?: MockTone; indent?: boolean; trailingHighlight?: string; delay?: number }
  | { type: 'blinkingCursor'; delay?: number }
  | { type: 'card'; title?: string; rows: { left: string; right?: string; tone?: MockTone }[]; delay?: number }
  | { type: 'pill'; text: string; tone?: MockTone; delay?: number }
  | { type: 'pulsingDot'; tone?: MockTone; size?: number; delay?: number }
  | { type: 'button'; label: string; primary?: boolean; delay?: number }
  | { type: 'input'; placeholder?: string; value?: string; focused?: boolean; delay?: number }
  | { type: 'spacer'; height?: number }
  | { type: 'text'; text: string; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; tone?: MockTone; weight?: 'normal' | 'bold'; delay?: number }
  | { type: 'counter'; from: number; to: number; prefix?: string; suffix?: string; delay?: number }
  | { type: 'avatar'; initials: string; tone?: MockTone; delay?: number }
  | { type: 'codeLine'; lineNumber?: number; tokens: { text: string; tone?: MockTone }[]; delay?: number }

export interface MarketingMock {
  frame?: {
    url?: string
    tone?: 'light' | 'dark'
  }
  layout?: 'row' | 'column'
  elements: MockElement[]
}

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
   *  this scene. Null = no screenshot, headline-only scene. Ignored when
   *  `mockCode` is set. */
  screenshotIndex: number | null
  /** Duration of this scene in seconds. The Remotion composition uses these
   *  to compute frame ranges so scene timings line up with the voice-over. */
  durationSeconds: number
  /** Legacy DSL mock — backwards-compat with persisted manifests. */
  mock?: MarketingMock
  /** Raw TSX the LLM wrote for this scene's animation. Diagnostics
   *  only — Remotion runs `mockCompiledCode`. */
  mockCode?: string
  /** esbuild output of mockCode. Remotion's `<DynamicScene>` wraps it
   *  in a `new Function(...)` with React + Remotion + branding bound,
   *  evaluates, and renders the resulting component. */
  mockCompiledCode?: string
  /** Architect-picked visual mode for this scene — one of
   *  hero-stat / bento / chat / chart / cursor-click / flow-diagram /
   *  headline-burst / logo-hero. Set by the skeleton stage so the
   *  per-scene designer call knows which template to follow. Optional
   *  for backwards-compat with manifests generated before the
   *  architect/designer split. */
  visualMode?: string
  /** Concrete visual brief written by the architect (skeleton stage)
   *  for this scene — 2-3 sentences naming the specific elements,
   *  numbers, words, and motion the designer should put on screen.
   *  The designer call turns this into TSX. Optional for the same
   *  backwards-compat reason. */
  visualBrief?: string
  /** Optional cadrage override picked by the architect: 'browser' |
   *  'mobile' | 'terminal' | 'fullbleed' | 'split'. Designer-only hint
   *  — the renderer doesn't consume it. Use `headlinePanel: false` to
   *  ALSO suppress the composition's headline panel (orthogonal: a mock
   *  can be `framing: 'browser'` AND `headlinePanel: false`). */
  framing?: string
  /** When false, the composition layer skips the headline panel and
   *  the mock occupies the full 1920×1080 canvas (instead of the
   *  default 920×580 area beside the panel). Default true. Use for a
   *  cinematic single-visual beat where any on-screen headline would
   *  compete with the mock; the voice-over carries the narrative. */
  headlinePanel?: boolean
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
  /** Architect-picked aesthetic for the whole video — one of the
   *  STYLE_SEEDS labels (editorial, brutalist, data-density, etc.).
   *  Drives the visual vocabulary the designer agents lean on, on top
   *  of each scene's per-scene visualBrief. Optional for backwards-
   *  compat with manifests generated before the architect-picked seed. */
  styleSeed?: string
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
  /** Optional secondary accent for two-tone gradients / variant chips.
   *  When absent the renderer falls back to a darker shade of accentColor. */
  accentSecondary?: string
  /** Hex — composition background. */
  bgColor: string
  /** Hex — primary text color. */
  textColor: string
  fontFamily: string
  logoUrl: string | null
  /** Public URL of the product (e.g. https://doclee.tech). When null, the
   *  Cta scene falls back to `${slugified-productName}.com`. */
  websiteUrl?: string | null
  /** Corner radius in px for primitives + the Cta button. Default 14. */
  radius?: number
}

export interface MarketingManifest {
  /** Id of the marketing_videos row this manifest belongs to. Renamed from
   *  Doclee's `runId` since this product has no run table. The render
   *  service still receives it as `runId` in its payload for backwards
   *  compatibility (see video.client.ts). */
  videoId: string
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
  /** Actual duration of the synthesized voice-over MP3 in seconds.
   *  Diverges from script.totalDurationSeconds because ElevenLabs adds
   *  real time for [short pause] / em-dashes / ellipses. The composition
   *  uses max(script, voiceover) so the audio is never cut off. */
  voiceoverDurationSeconds?: number
  /** Optional URL of a background music track to mix under the voice-over.
   *  Null = silent. Sourced from a preset library or a user upload. */
  musicUrl?: string | null
  /** Storage path of an uploaded music file (relative to artifacts bucket).
   *  Distinct from musicUrl: a preset has a URL but no path, an upload has
   *  both. Lets us keep the signed URL fresh on re-render. */
  musicPath?: string | null
  /** Linear volume 0–1 for the music. Defaults to 0.15. */
  musicVolume?: number
  /** When music was requested but generation/upload failed, this carries
   *  the human-readable reason. The manifest is still saved (with
   *  musicUrl=null) so the user keeps their script + voice-over instead
   *  of losing everything to a music-only failure. UI surfaces this as
   *  a non-blocking warning. */
  musicError?: string | null
  /** Public URL to the JPEG thumbnail of a punchy frame (default: 4s into
   *  the video, end of the hook with the headline in place). Used as the
   *  video player's `poster`, the public-docs og:image, and the social
   *  card preview. Captured client-side after the first render and
   *  uploaded via POST /api/runs/:id/marketing-video/thumbnail. */
  thumbnailUrl?: string | null
  /** Storage path of the thumbnail (relative to artifacts bucket). */
  thumbnailPath?: string | null
}

/** Render lifecycle of the MP4. The manifest can exist without a render
 *  (script + voice-over only), or with a render in any of these states. */
/**
 * Lifecycle of a marketing_videos row.
 *   - 'idle' — no in-flight work, no render yet (initial state and the
 *     state between manifest edits and a re-render).
 *   - 'generating' — script + voice + music in flight.
 *   - 'rendering' — manifest persisted, Remotion render in flight.
 *   - 'ready' — MP4 uploaded, video_url populated.
 *   - 'failed' — terminal; render_error carries the human-readable reason.
 */
export type MarketingVideoRenderStatus = 'idle' | 'generating' | 'rendering' | 'ready' | 'failed'

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
export type VoiceTone =
  | 'punchy'         // energetic, marketing-default
  | 'calm'           // measured, soft
  | 'playful'        // expressive, casual
  | 'serious'        // authoritative, monotone
  | 'confident'      // warm + authoritative — founder pitch
  | 'inspirational'  // uplifting, building energy
  | 'conversational' // natural, podcast-style

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
  /** Visual style for the whole video — every scene is either a real
   *  screenshot or an LLM-designed animated mock, NOT mixed. Defaults
   *  to 'screenshots'. */
  visualMode?: 'screenshots' | 'mocks'
  /** Background music track ID — picked from MUSIC_PRESETS. Mutually
   *  exclusive with `musicUploadPath`. Use 'none' to explicitly disable.
   *  Special value 'ai' triggers ElevenLabs Music generation, optionally
   *  steered by aiMusicPrompt. */
  musicTrackId?: string
  /** Storage path (in artifacts bucket) of a music file the user uploaded
   *  via the signed-upload endpoint. Mutually exclusive with musicTrackId. */
  musicUploadPath?: string
  /** Linear 0–1 volume for the music. Defaults to 0.15. */
  musicVolume?: number
  /** Free-form music style brief used only when musicTrackId === 'ai'.
   *  e.g. "trap drums and synth bass" / "minimal piano, no drums". */
  aiMusicPrompt?: string
  /** Free-form steering from the user — tells Gemini what angle to take,
   *  who the target audience is, which feature to emphasize, what tone
   *  shift to apply. The doc remains the content source-of-truth; this is
   *  purely a creative brief layered on top.
   *  Example: "Focus on the AI agent that tests your docs. Audience is
   *  technical PMs in B2B SaaS. Tone: confident, slightly cheeky."  */
  userPrompt?: string
}
