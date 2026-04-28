import { findRunById } from '../run/run.repository.js'
import { findStepsByRunId } from '../run/run.repository.js'
import { findPageById } from '../page/page.repository.js'
import { findProjectById } from '../project/project.repository.js'
import { getPublicUrl, uploadToStorage } from '../../shared/db/storage.repository.js'
import { synthesizeSpeech, isElevenLabsConfigured } from '../../shared/ai/elevenlabs.client.js'
import { generateMarketingScript } from './marketing-script.generator.js'
import { saveMarketingVideo } from './marketing-video.repository.js'
import type {
  GenerateMarketingVideoOptions,
  MarketingBranding,
  MarketingManifest,
  MarketingScreenshot,
  MarketingVideoSummary,
} from './marketing-video.types.js'

/** Background-music presets. Empty by default — drop royalty-free MP3s into
 *  any public CDN (Pixabay, Free Music Archive, your own Supabase bucket)
 *  and add an entry here. The UI exposes whatever is in this list as a
 *  picker. Users can also upload their own track which bypasses this list
 *  entirely (musicUploadPath in the generate options).
 *
 *  Required fields per entry:
 *    id      — short stable string, sent in API requests
 *    name    — shown in the picker
 *    url     — direct mp3 URL fetchable by Remotion at render time
 *    mood    — optional one-word tag the picker groups by
 *
 *  Add tracks here:
 */
export const MUSIC_PRESETS: Array<{ id: string; name: string; url: string; mood?: string }> = [
  // { id: 'upbeat-corporate', name: 'Upbeat Corporate', mood: 'Energetic',
  //   url: 'https://your-cdn/upbeat-corporate.mp3' },
]

const DEFAULT_MUSIC_VOLUME = 0.15

/** ElevenLabs voice_settings tuned per tone. The triplet maps to:
 *  - stability: lower = more dynamic delivery (variable pitch / pace),
 *    higher = monotone, robotic.
 *  - style: higher = more stylistic exaggeration (good for punchy /
 *    playful), lower = neutral read.
 *  - similarityBoost: how tightly to stick to the source voice timbre.
 *  These were picked by ear, not science — adjust to taste. */
const TONE_PRESETS = {
  punchy:  { stability: 0.35, style: 0.70, similarityBoost: 0.80 },
  calm:    { stability: 0.65, style: 0.30, similarityBoost: 0.75 },
  playful: { stability: 0.30, style: 0.85, similarityBoost: 0.70 },
  serious: { stability: 0.70, style: 0.20, similarityBoost: 0.80 },
} as const

/** Default branding when the project has no custom design saved. Picked to
 *  produce a usable marketing video out of the box rather than a blank
 *  black-on-white render that looks unfinished. */
const DEFAULT_BRANDING: MarketingBranding = {
  productName: 'Doclee',
  accentColor: '#5B5BD6',
  bgColor: '#0B0B0F',
  textColor: '#F5F5F7',
  fontFamily: 'Inter',
  logoUrl: null,
}

/** Cheap diacritic + stopword heuristic — same approach as the doc voice-over.
 *  Returns ISO-639 codes since Gemini handles those better than English
 *  language names in the prompt. */
function detectLanguage(markdown: string): string {
  if (!markdown || markdown.length < 30) return 'en'
  const text = markdown.toLowerCase()
  const diacritics = (text.match(/[àâäéèêëïîôöùûüÿç]/g) ?? []).length
  const fr = (text.match(/\b(le|la|les|un|une|des|du|est|sont|avec|pour|dans|sur|que|qui|cette|ces|nous|vous|votre|cliquez|saisissez)\b/g) ?? []).length
  const en = (text.match(/\b(the|is|are|with|for|in|on|that|which|this|but|we|you|your|click|open|enter|press|type)\b/g) ?? []).length
  return diacritics * 3 + fr > en * 1.3 ? 'fr' : 'en'
}

/**
 * Build the per-run branding bundle Remotion uses for colors, fonts and the
 * product logo. Falls back to the default theme for projects that haven't
 * customized their design yet.
 */
async function resolveBranding(projectId: string | null): Promise<MarketingBranding> {
  if (!projectId) return DEFAULT_BRANDING
  const project = await findProjectById(projectId)
  if (!project) return DEFAULT_BRANDING

  const design = project.design
  return {
    productName: project.name,
    accentColor: design?.accentColor ?? DEFAULT_BRANDING.accentColor,
    bgColor: design?.bgColor ?? DEFAULT_BRANDING.bgColor,
    textColor: design?.textColor ?? DEFAULT_BRANDING.textColor,
    fontFamily: design?.font ?? DEFAULT_BRANDING.fontFamily,
    logoUrl: design?.logoUrl ?? null,
  }
}

/**
 * Resolve the screenshots Remotion will animate. Pulls paths from the run's
 * steps (already populated during video analysis or live exploration), turns
 * them into public URLs, and pairs each with the step's caption so the AI
 * script generator can pick a screenshot whose content matches the scene.
 *
 * Steps without a screenshot path are filtered out — Remotion can't show
 * what doesn't exist, and feeding a null index to the script generator just
 * tempts it to invent visuals.
 */
async function collectScreenshots(runId: string): Promise<MarketingScreenshot[]> {
  const steps = await findStepsByRunId(runId)
  const result: MarketingScreenshot[] = []
  for (const s of steps.sort((a, b) => a.stepIndex - b.stepIndex)) {
    if (!s.screenshotPath) continue
    const url = getPublicUrl('artifacts', s.screenshotPath)
    if (!url) continue
    result.push({
      url,
      caption: s.title || s.action || `Step ${s.stepIndex + 1}`,
    })
  }
  return result
}

/**
 * Concatenates the script's voice-over chunks (hook + scenes + CTA) into a
 * single narration string for ElevenLabs. We don't synthesize per-scene and
 * stitch with silence padding (like the doc voice-over does) because the
 * marketing video has no fixed timestamps to sync to — Remotion adapts scene
 * durations to the audio it gets, not the other way around.
 */
function flattenScriptToNarration(script: import('./marketing-video.types.js').MarketingScript): string {
  const parts: string[] = [script.hook.voiceover]
  for (const scene of script.scenes) parts.push(scene.voiceover)
  parts.push(script.cta.voiceover)
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(' ')
}

/**
 * Full marketing-video pipeline: pulls the doc + branding + screenshots,
 * asks Gemini for a 60s script, synthesizes the narration via ElevenLabs
 * (optional), uploads the audio, and persists a manifest on the run summary.
 *
 * The manifest is what Remotion consumes to render. Server-side render is
 * NOT in this MVP — call `npm run marketing:preview <runId>` to iterate the
 * template locally with the manifest fed in.
 */
export async function generateMarketingVideoForRun(
  runId: string,
  options: GenerateMarketingVideoOptions = {},
): Promise<MarketingVideoSummary> {
  const run = await findRunById(runId)
  if (!run) throw new Error(`Run not found: ${runId}`)

  // Need a doc page to drive the script — without it we'd be writing
  // marketing copy from steps alone, which produces play-by-play not pitch.
  if (!run.docPageId) {
    throw new Error('This run has no linked page. Marketing video needs the page documentation as input.')
  }
  const page = await findPageById(run.docPageId)
  if (!page) throw new Error('Linked page not found')

  const sourceMarkdown = page.content?.trim()
  if (!sourceMarkdown) {
    throw new Error('Page has no content yet. Generate or write the doc before creating a marketing video.')
  }

  const branding = await resolveBranding(page.projectId)
  const screenshots = await collectScreenshots(runId)
  const language = detectLanguage(sourceMarkdown)

  console.log(`[marketing-video] Run ${runId}: ${screenshots.length} screenshots, lang=${language}, product="${branding.productName}"`)

  const script = await generateMarketingScript({
    productName: branding.productName,
    pageTitle: page.title,
    pageMarkdown: sourceMarkdown,
    availableScreenshots: screenshots.length,
    screenshotCaptions: screenshots.map((s) => s.caption),
    language,
    userPrompt: options.userPrompt,
  })

  console.log(`[marketing-video] Script: ${script.scenes.length} scenes, ${script.totalDurationSeconds}s total`)

  // Voice-over (optional). Default true — we want the BIM. Skipping is for
  // template iteration where you don't want to burn ElevenLabs credits on
  // every preview tweak.
  const withVoiceover = options.withVoiceover ?? true
  let voiceoverPath: string | null = null
  let voiceoverUrl: string | null = null

  if (withVoiceover) {
    if (!isElevenLabsConfigured()) {
      throw new Error('ELEVENLABS_API_KEY is required for voice-over. Re-run with withVoiceover=false to skip.')
    }
    const narration = flattenScriptToNarration(script)
    const tone = options.tone ?? 'punchy'
    const settings = TONE_PRESETS[tone]
    console.log(`[marketing-video] Voice settings: tone=${tone}, voice=${options.voiceId ?? 'default'}`)
    const buffer = await synthesizeSpeech(narration, {
      voiceId: options.voiceId,
      stability: settings.stability,
      style: settings.style,
      similarityBoost: settings.similarityBoost,
    })
    voiceoverPath = `runs/${runId}/marketing-voiceover.mp3`
    await uploadToStorage('artifacts', voiceoverPath, buffer, 'audio/mpeg')
    voiceoverUrl = `${getPublicUrl('artifacts', voiceoverPath) ?? ''}?v=${Date.now()}`
    console.log(`[marketing-video] Voice-over uploaded: ${voiceoverUrl}`)
  }

  // Resolve background music. Priority: explicit upload > preset by id >
  // none. Either path resolves to a public URL Remotion can <Audio src>.
  let musicUrl: string | null = null
  let musicPath: string | null = null
  if (options.musicUploadPath) {
    musicPath = options.musicUploadPath
    musicUrl = `${getPublicUrl('artifacts', musicPath) ?? ''}?v=${Date.now()}`
    console.log(`[marketing-video] Music: uploaded path=${musicPath}`)
  } else if (options.musicTrackId && options.musicTrackId !== 'none') {
    const preset = MUSIC_PRESETS.find((p) => p.id === options.musicTrackId)
    if (preset) {
      musicUrl = preset.url
      console.log(`[marketing-video] Music: preset ${preset.id} (${preset.name})`)
    } else {
      console.warn(`[marketing-video] Music: preset id "${options.musicTrackId}" not found in MUSIC_PRESETS, skipping`)
    }
  }
  const musicVolume = options.musicVolume ?? DEFAULT_MUSIC_VOLUME

  const manifest: MarketingManifest = {
    runId,
    generatedAt: new Date().toISOString(),
    script,
    screenshots,
    branding,
    voiceoverUrl,
    voiceoverPath,
    musicUrl,
    musicPath,
    musicVolume,
  }

  // Persist the manifest itself in artifacts storage. Remotion (or a future
  // cloud render service) can fetch it by URL without going through the API.
  const manifestPath = `runs/${runId}/marketing-manifest.json`
  await uploadToStorage(
    'artifacts',
    manifestPath,
    Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
    'application/json',
  )
  const manifestUrl = `${getPublicUrl('artifacts', manifestPath) ?? ''}?v=${Date.now()}`

  const summary: MarketingVideoSummary = {
    manifest,
    manifestUrl,
    videoUrl: null,
    videoPath: null,
    renderStatus: 'idle',
    renderError: null,
  }

  await saveMarketingVideo(runId, summary)
  return summary
}

/**
 * GET the bundle's index.html and verify it's actually a Remotion bundle
 * (contains the `getStaticCompositions` global registered by `remotion`).
 *
 * Why: when this URL silently returns the wrong page (Vercel deploy
 * protection auth wall, SPA shell from a catch-all rewrite, etc.) the
 * video-service hits JSON.parse on something downstream and reports the
 * useless "Unexpected token '<'" back. We want the actionable error
 * here.
 */
async function preflightRemotionBundle(serveUrl: string): Promise<void> {
  const indexUrl = `${serveUrl.replace(/\/+$/, '')}/index.html`
  let res: Response
  try {
    res = await fetch(indexUrl, { redirect: 'follow' })
  } catch (err) {
    throw new Error(`Remotion bundle unreachable at ${indexUrl}: ${(err as Error).message}`)
  }
  if (!res.ok) {
    throw new Error(`Remotion bundle returned HTTP ${res.status} at ${indexUrl}`)
  }
  const body = await res.text()
  if (!body.includes('getStaticCompositions') && !body.includes('Remotion Bundle')) {
    const preview = body.replace(/\s+/g, ' ').slice(0, 200)
    if (body.includes('vc-dash-sidebar-width') || body.includes('skip-nav-link-module')) {
      throw new Error(
        `Remotion bundle URL ${indexUrl} is behind Vercel deployment protection — ` +
          `disable "Vercel Authentication" in Project Settings → Deployment Protection, ` +
          `or merge to main and use the production URL.`,
      )
    }
    throw new Error(
      `Remotion bundle URL ${indexUrl} did not return a Remotion bundle. ` +
        `First 200 chars: "${preview}". ` +
        `Likely an SPA-fallback rewrite, missing build artifact, or cached old deploy.`,
    )
  }
}

/**
 * GET the manifest URL, verify it's JSON, and return the parsed object.
 *
 * Same rationale as preflightRemotionBundle for the verification — an
 * HTML body here surfaces only as the video-service's downstream
 * "Unexpected token '<'". Returning the parsed manifest lets us also
 * ship the content inline to the service so it can skip its own fetch
 * if/when the service contract is updated to read it.
 */
async function preflightManifest(manifestUrl: string): Promise<MarketingManifest> {
  let res: Response
  try {
    res = await fetch(manifestUrl, { redirect: 'follow' })
  } catch (err) {
    throw new Error(`Manifest unreachable at ${manifestUrl}: ${(err as Error).message}`)
  }
  if (!res.ok) {
    throw new Error(`Manifest returned HTTP ${res.status} at ${manifestUrl}`)
  }
  const contentType = res.headers.get('content-type') ?? ''
  const body = await res.text()
  if (!contentType.includes('json') && !body.trimStart().startsWith('{')) {
    const preview = body.replace(/\s+/g, ' ').slice(0, 200)
    throw new Error(
      `Manifest URL ${manifestUrl} returned ${contentType || 'unknown content-type'} instead of JSON. ` +
        `First 200 chars: "${preview}". ` +
        `Likely the artifacts bucket isn't public or the URL is being intercepted.`,
    )
  }
  try {
    return JSON.parse(body) as MarketingManifest
  } catch (err) {
    throw new Error(`Manifest at ${manifestUrl} is not valid JSON: ${(err as Error).message}`)
  }
}

/** Where the pre-bundled Remotion site lives. Resolution order:
 *  1. REMOTION_SERVE_URL env — escape hatch when the bundle is hosted
 *     somewhere other than the current deploy (rare).
 *  2. On a Vercel preview deploy (VERCEL_ENV=preview), prefer the deploy's
 *     own URL via VERCEL_BRANCH_URL / VERCEL_URL. Without this, preview
 *     renders would point at PUBLIC_APP_URL (production) and pick up the
 *     PRODUCTION bundle, defeating the purpose of testing changes on a
 *     preview before merging.
 *  3. PUBLIC_APP_URL + /remotion-bundle — the production default.
 *  4. Throw — no URL we can derive. */
function resolveRemotionServeUrl(): string {
  const explicit = process.env.REMOTION_SERVE_URL
  if (explicit && explicit.length > 0) return explicit

  if (process.env.VERCEL_ENV === 'preview') {
    const previewHost = process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL
    if (previewHost) return `https://${previewHost.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/remotion-bundle`
  }

  const publicAppUrl = process.env.PUBLIC_APP_URL
  if (publicAppUrl) return `${publicAppUrl.replace(/\/+$/, '')}/remotion-bundle`
  throw new Error(
    'No Remotion serve URL configured. Set PUBLIC_APP_URL (recommended — the bundle ships with the main deploy via the `prebuild` script) or REMOTION_SERVE_URL.',
  )
}

/**
 * Trigger a render of the persisted manifest. Calls the standalone
 * video-service (which has Chromium + Remotion) and updates the run summary
 * when the MP4 lands.
 *
 * Synchronous against the video-service today — for a 60s 1080p render that
 * lands in ~2-5 min, well inside Vercel's 300s function cap. If we ever
 * blow past that, switch to the existing job pattern in run/job.repository
 * and have the video-service post back.
 */
export async function renderMarketingVideoForRun(
  runId: string,
): Promise<MarketingVideoSummary> {
  const { findMarketingVideoByRunId } = await import('./marketing-video.repository.js')
  const existing = await findMarketingVideoByRunId(runId)
  if (!existing) {
    throw new Error(
      'No marketing-video manifest for this run. Generate one first via POST /marketing-video.',
    )
  }
  if (!existing.manifestUrl) {
    throw new Error('Manifest exists in DB but has no public URL — cannot render without it.')
  }

  const { isVideoServiceConfigured, renderMarketingVideo } = await import('../../shared/video/video.client.js')
  if (!isVideoServiceConfigured()) {
    throw new Error('VIDEO_SERVICE_URL is not configured — cannot render marketing video.')
  }

  // Mark rendering immediately so concurrent reads see the in-flight state.
  await saveMarketingVideo(runId, {
    ...existing,
    renderStatus: 'rendering',
    renderError: null,
  })

  try {
    const remotionServeUrl = resolveRemotionServeUrl()

    // Pre-flight: verify both URLs the video-service will fetch are
    // serving the expected content. Without this, problems like Vercel
    // deploy protection, SPA-fallback rewrites swallowing the bundle
    // path, or a stale Supabase signed URL surface only as the cryptic
    // "Unexpected token '<'" the video-service reports back from its
    // own JSON.parse failure. Fail here with a clear, actionable error.
    console.log(`[marketing-video] Pre-flight: bundle=${remotionServeUrl} manifest=${existing.manifestUrl}`)
    await preflightRemotionBundle(remotionServeUrl)
    const manifestContent = await preflightManifest(existing.manifestUrl)

    const videoPath = await renderMarketingVideo({
      runId,
      manifestUrl: existing.manifestUrl,
      // Ship the verified manifest content inline so a service-side
      // update can skip its own fetch (which is the most likely source
      // of the cryptic "Unexpected token '<'" the service has been
      // returning). Today's service may ignore this field — that's
      // fine, it's purely additive.
      manifest: manifestContent,
      remotionServeUrl,
    })

    const videoUrl = `${getPublicUrl('artifacts', videoPath) ?? ''}?v=${Date.now()}`
    const ready: MarketingVideoSummary = {
      ...existing,
      videoPath,
      videoUrl,
      renderStatus: 'ready',
      renderError: null,
    }
    await saveMarketingVideo(runId, ready)
    return ready
  } catch (err) {
    const failed: MarketingVideoSummary = {
      ...existing,
      renderStatus: 'failed',
      renderError: (err as Error).message,
    }
    await saveMarketingVideo(runId, failed)
    throw err
  }
}
