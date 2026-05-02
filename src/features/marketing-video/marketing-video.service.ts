import { findRunById } from '../run/run.repository.js'
import { findStepsByRunId } from '../run/run.repository.js'
import { findPageById } from '../page/page.repository.js'
import { getPublicUrl, uploadToStorage } from '../../shared/db/storage.repository.js'
import { synthesizeSpeech, generateMusic, isElevenLabsConfigured } from '../../shared/ai/elevenlabs.client.js'
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

/** Music style brief per voice tone. Used as the base prompt for ElevenLabs
 *  Music generation, optionally extended with the user's own steering text.
 *  Kept short and concrete — long prompts produce muddier output. */
const TONE_TO_MUSIC_PROMPT: Record<import('./marketing-video.types.js').VoiceTone, string> = {
  punchy:  'Energetic upbeat marketing music, electronic, driving rhythm, modern, confident',
  calm:    'Calm ambient background music, minimal piano, professional, soft pads',
  playful: 'Fun upbeat marketing music, playful melodies, light percussion, optimistic',
  serious: 'Subtle cinematic background music, building tension, professional, restrained',
}

function buildMusicPrompt(
  tone: import('./marketing-video.types.js').VoiceTone,
  userBrief: string | undefined,
  productName: string,
): string {
  const base = TONE_TO_MUSIC_PROMPT[tone]
  const extended = userBrief?.trim() ? `${base}, ${userBrief.trim()}` : base
  // Keep it under ElevenLabs' practical prompt window. The product name
  // anchors the generation slightly without forcing a literal mention.
  return `${extended}. Background music for a ${productName} marketing video. Instrumental, no vocals.`
}

/** ElevenLabs voice_settings tuned per tone. The triplet maps to:
 *  - stability: lower = more dynamic delivery (variable pitch / pace),
 *    higher = monotone, robotic. Past ~0.6 the voice flattens noticeably.
 *  - style: higher = more stylistic exaggeration. Above ~0.85 the model
 *    can become inconsistent — we sit at 0.90 max.
 *  - similarityBoost: how tightly to stick to the source voice timbre.
 *
 *  These were re-tuned aggressively (was: 0.35 / 0.70 / 0.80) because the
 *  earlier mid-range values produced near-identical voiceovers across
 *  presets — the user heard a monotone read regardless of tone choice.
 *  The current values pull each preset to a recognisable extreme. */
const TONE_PRESETS = {
  punchy:  { stability: 0.20, style: 0.90, similarityBoost: 0.75 },
  calm:    { stability: 0.55, style: 0.35, similarityBoost: 0.80 },
  playful: { stability: 0.15, style: 0.90, similarityBoost: 0.70 },
  serious: { stability: 0.55, style: 0.25, similarityBoost: 0.85 },
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
  // getProject (vs. findProjectById) re-signs stale public logo URLs so
  // Remotion can fetch the logo even if the artifacts bucket isn't public.
  const { getProject } = await import('../project/project.service.js')
  let project
  try {
    project = await getProject(projectId)
  } catch {
    return DEFAULT_BRANDING
  }

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
/**
 * Synthesize the marketing voice-over via ElevenLabs and upload to storage.
 * Pulled out of generateMarketingVideoForRun so the
 * /update-voiceover endpoint can re-run JUST the synthesis without touching
 * the script — when the user picks a different voice or tone post-generation.
 */
async function synthesizeMarketingVoiceover(
  runId: string,
  script: import('./marketing-video.types.js').MarketingScript,
  options: GenerateMarketingVideoOptions,
): Promise<{ voiceoverPath: string; voiceoverUrl: string; voiceoverDurationSeconds: number }> {
  if (!isElevenLabsConfigured()) {
    throw new Error('ELEVENLABS_API_KEY is required for voice-over.')
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
  const voiceoverPath = `runs/${runId}/marketing-voiceover.mp3`
  await uploadToStorage('artifacts', voiceoverPath, buffer, 'audio/mpeg')
  const voiceoverUrl = `${getPublicUrl('artifacts', voiceoverPath) ?? ''}?v=${Date.now()}`

  // Probe the MP3 properly via music-metadata. The previous heuristic
  // (buffer.length / 16000) systematically overestimated by ~5-10%
  // because it ignored MP3 frame headers and VBR; the composition then
  // ran longer than the script asked for. music-metadata reads frame
  // counts directly so the value is accurate within ~50ms.
  const { parseBuffer } = await import('music-metadata')
  const meta = await parseBuffer(buffer, { mimeType: 'audio/mpeg' }, { duration: true })
  const voiceoverDurationSeconds = meta.format.duration ?? Math.max(1, buffer.length / 16000)
  console.log(`[marketing-video] Voice-over uploaded: ${voiceoverUrl} (${voiceoverDurationSeconds.toFixed(2)}s)`)
  return { voiceoverPath, voiceoverUrl, voiceoverDurationSeconds }
}

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
    // Same tone drives both the script (which audio tags to embed) and
    // the voice (ElevenLabs settings). Without this the script comes out
    // flat and even an expressive voice setting reads it flat.
    tone: options.tone ?? 'punchy',
    visualMode: options.visualMode ?? 'screenshots',
    userPrompt: options.userPrompt,
  })

  console.log(`[marketing-video] Script: ${script.scenes.length} scenes, ${script.totalDurationSeconds}s total`)

  // Compile any TSX mockCode the LLM emitted. Failures are isolated:
  // a scene that fails to compile drops mockCode silently and falls
  // through to its screenshot — better than killing the whole run.
  if (options.visualMode === 'mocks') {
    const { compileMockCode } = await import('./mock-code.compiler.js')
    for (const scene of script.scenes) {
      if (!scene.mockCode || scene.mockCode.trim().length === 0) continue
      try {
        const { compiled } = await compileMockCode(scene.mockCode)
        scene.mockCompiledCode = compiled
      } catch (err) {
        console.warn(`[marketing-video] mockCode compile failed for scene "${scene.headline}": ${(err as Error).message}`)
        // Drop the field so the renderer falls back to screenshot /
        // accent gradient. Keep the raw source for diagnostics.
        delete scene.mockCompiledCode
      }
    }
    const compiled = script.scenes.filter((s) => s.mockCompiledCode).length
    console.log(`[marketing-video] Compiled ${compiled}/${script.scenes.length} scene mocks`)
  }

  // Voice-over (optional). Default true — we want the BIM. Skipping is for
  // template iteration where you don't want to burn ElevenLabs credits on
  // every preview tweak.
  const withVoiceover = options.withVoiceover ?? true
  let voiceoverPath: string | null = null
  let voiceoverUrl: string | null = null
  let voiceoverDurationSeconds: number | undefined

  if (withVoiceover) {
    const result = await synthesizeMarketingVoiceover(runId, script, options)
    voiceoverPath = result.voiceoverPath
    voiceoverUrl = result.voiceoverUrl
    voiceoverDurationSeconds = result.voiceoverDurationSeconds
  }

  // Resolve background music. Priority: explicit upload > AI generation
  // > preset by id > none. Either path resolves to a public URL Remotion
  // can <Audio src>.
  //
  // Music failures are NON-FATAL — script + voice-over have already been
  // generated (and paid for) by the time we get here, so an ElevenLabs
  // music permission issue or a bad preset URL shouldn't roll the whole
  // pipeline back. Capture the error in musicError, set musicUrl=null,
  // continue. The UI shows a warning and the user gets a silent video
  // instead of nothing.
  let musicUrl: string | null = null
  let musicPath: string | null = null
  let musicError: string | null = null
  try {
    if (options.musicUploadPath) {
      musicPath = options.musicUploadPath
      musicUrl = `${getPublicUrl('artifacts', musicPath) ?? ''}?v=${Date.now()}`
      console.log(`[marketing-video] Music: uploaded path=${musicPath}`)
    } else if (options.musicTrackId === 'ai') {
      if (!isElevenLabsConfigured()) {
        throw new Error('ELEVENLABS_API_KEY is required for AI music generation.')
      }
      const tone = options.tone ?? 'punchy'
      const musicPrompt = buildMusicPrompt(tone, options.aiMusicPrompt, branding.productName)
      const durationMs = Math.round(script.totalDurationSeconds * 1000)
      console.log(`[marketing-video] Music: AI-generating, durationMs=${durationMs}`)
      const buffer = await generateMusic(musicPrompt, { durationMs })
      musicPath = `runs/${runId}/marketing-music-ai.mp3`
      await uploadToStorage('artifacts', musicPath, buffer, 'audio/mpeg')
      musicUrl = `${getPublicUrl('artifacts', musicPath) ?? ''}?v=${Date.now()}`
      console.log(`[marketing-video] Music: AI track uploaded → ${musicUrl}`)
    } else if (options.musicTrackId && options.musicTrackId !== 'none') {
      const preset = MUSIC_PRESETS.find((p) => p.id === options.musicTrackId)
      if (preset) {
        musicUrl = preset.url
        console.log(`[marketing-video] Music: preset ${preset.id} (${preset.name})`)
      } else {
        console.warn(`[marketing-video] Music: preset id "${options.musicTrackId}" not found in MUSIC_PRESETS, skipping`)
      }
    }
  } catch (err) {
    // Surface the underlying message to the UI — ElevenLabs already
    // returns clean strings like "missing the permission music_generation"
    // which are actionable as-is.
    musicError = (err as Error).message
    musicUrl = null
    musicPath = null
    console.warn(`[marketing-video] Music generation failed (non-fatal): ${musicError}`)
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
    voiceoverDurationSeconds,
    musicUrl,
    musicPath,
    musicVolume,
    musicError,
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

/**
 * Re-synthesize the voice-over on an existing manifest with a new
 * voice / tone, without touching the script, screenshots, music or
 * branding. Persists the updated manifest (uploads the new JSON to
 * storage so the public URL reflects the change) and returns the
 * fresh summary so the UI can refresh.
 *
 * Use case: user generated, listened, didn't like the voice — they
 * change the picker + tone and click "Update voice" instead of
 * regenerating the whole script (which would burn another Gemini call
 * and could change wording).
 */
export async function updateMarketingVoiceoverForRun(
  runId: string,
  options: { voiceId?: string; tone?: import('./marketing-video.types.js').VoiceTone },
): Promise<MarketingVideoSummary> {
  const { findMarketingVideoByRunId } = await import('./marketing-video.repository.js')
  const existing = await findMarketingVideoByRunId(runId)
  if (!existing) throw new Error('No marketing-video manifest for this run yet — generate one first.')

  const { voiceoverPath, voiceoverUrl, voiceoverDurationSeconds } = await synthesizeMarketingVoiceover(
    runId,
    existing.manifest.script,
    { voiceId: options.voiceId, tone: options.tone },
  )

  const updatedManifest: MarketingManifest = {
    ...existing.manifest,
    voiceoverUrl,
    voiceoverPath,
    voiceoverDurationSeconds,
    generatedAt: new Date().toISOString(),
  }

  // Re-upload the manifest JSON so the URL the video-service fetches
  // reflects the new voice-over. Same path → overwrite, only the ?v=
  // changes.
  const manifestPath = `runs/${runId}/marketing-manifest.json`
  await uploadToStorage(
    'artifacts',
    manifestPath,
    Buffer.from(JSON.stringify(updatedManifest, null, 2), 'utf-8'),
    'application/json',
  )
  const manifestUrl = `${getPublicUrl('artifacts', manifestPath) ?? ''}?v=${Date.now()}`

  const updated: MarketingVideoSummary = {
    ...existing,
    manifest: updatedManifest,
    manifestUrl,
    // Voice changed → existing MP4 is stale. Reset render status so the
    // UI prompts the user to re-render.
    videoUrl: null,
    videoPath: null,
    renderStatus: 'idle',
    renderError: null,
  }
  await saveMarketingVideo(runId, updated)
  return updated
}

/**
 * Persist a user-edited manifest. The script + branding + screenshots +
 * music volume can be tweaked in place; voice-over URLs / paths and
 * music URLs are intentionally NOT accepted from the client (changing
 * them would let a caller point Remotion at any URL — re-synthesize via
 * /:id/marketing-video/voiceover for voice changes).
 *
 * Flow:
 *   1. Read the existing summary (404s when there's no manifest yet).
 *   2. Merge the patch on top — fields the user didn't include keep
 *      their persisted value.
 *   3. Upload the JSON to the same storage path → cache-busts the URL.
 *   4. Reset renderStatus to 'idle' so the UI prompts a fresh render.
 */
export async function updateMarketingManifestForRun(
  runId: string,
  patch: import('./marketing-video.schema.js').UpdateMarketingManifestInput,
): Promise<MarketingVideoSummary> {
  const { findMarketingVideoByRunId } = await import('./marketing-video.repository.js')
  const existing = await findMarketingVideoByRunId(runId)
  if (!existing) throw new Error('No marketing-video manifest for this run yet — generate one first.')

  // Cast through `as` because the schema's inferred type uses a permissive
  // MockElement shape (`type: z.string()`) — the discriminated-union types
  // in marketing-video.types.ts are stricter. The Zod validator already
  // gated the runtime shape; the cast just bridges the structural gap.
  const updatedManifest: MarketingManifest = {
    ...existing.manifest,
    script: patch.script as MarketingManifest['script'],
    ...(patch.screenshots ? { screenshots: patch.screenshots } : {}),
    ...(patch.branding ? { branding: patch.branding } : {}),
    ...(typeof patch.musicVolume === 'number' ? { musicVolume: patch.musicVolume } : {}),
    generatedAt: new Date().toISOString(),
  }

  const manifestPath = `runs/${runId}/marketing-manifest.json`
  await uploadToStorage(
    'artifacts',
    manifestPath,
    Buffer.from(JSON.stringify(updatedManifest, null, 2), 'utf-8'),
    'application/json',
  )
  const manifestUrl = `${getPublicUrl('artifacts', manifestPath) ?? ''}?v=${Date.now()}`

  const updated: MarketingVideoSummary = {
    ...existing,
    manifest: updatedManifest,
    manifestUrl,
    // Manifest changed → the existing MP4 no longer matches its source.
    // We deliberately KEEP videoUrl + videoPath so the user doesn't
    // lose their preview while iterating; only flip renderStatus to
    // 'idle'. The UI uses that combination (videoUrl present + status
    // 'idle') to show the old video alongside a "manifest edited,
    // re-render to apply" banner. The next /render overwrites the path.
    renderStatus: 'idle',
    renderError: null,
  }
  await saveMarketingVideo(runId, updated)
  return updated
}

/**
 * AI-driven manifest edit. The user types a free-form instruction
 * ("shorten scene 2 by 2 seconds and make it punchier", "switch the
 * accent color to blue", "rewrite the CTA in french") and Gemini
 * returns the updated manifest + a one-line confirmation. Internally
 * routes the new manifest through updateMarketingManifestForRun, so
 * the edit goes through the same validation + storage + render-status
 * reset path as a manual JSON edit.
 *
 * Costs: one Gemini Pro call (~€0.04). NOT counted against the
 * marketing_video quota — that counter tracks full pipelines (script
 * + voice + music + render). Quota-gated up-front so a hard-cap plan
 * over budget can't iterate either.
 */
export async function editMarketingManifestWithAi(
  runId: string,
  input: {
    instruction: string
    history?: { role: 'user' | 'assistant'; content: string }[]
  },
): Promise<{ summary: MarketingVideoSummary; message: string }> {
  const { findMarketingVideoByRunId } = await import('./marketing-video.repository.js')
  const existing = await findMarketingVideoByRunId(runId)
  if (!existing) throw new Error('No marketing-video manifest for this run yet — generate one first.')

  const { generateText, GEMINI_PRO_MODEL } = await import('../../shared/ai/gemini.client.js')

  // Trim mockCompiledCode out of the snapshot we feed Gemini — it's
  // esbuild output, not human-edited, and inflates the prompt by ~2-3×
  // for no signal. We re-compile it server-side after the edit lands.
  const editableScript = {
    ...existing.manifest.script,
    scenes: existing.manifest.script.scenes.map((s) => ({
      ...s,
      mockCompiledCode: undefined,
    })),
  }

  const historyBlock = (input.history ?? [])
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')

  const prompt = `You are editing a marketing video manifest based on a user instruction.

## Product
${existing.manifest.branding.productName}

## Current manifest script
\`\`\`json
${JSON.stringify(editableScript, null, 2)}
\`\`\`

## Current branding
\`\`\`json
${JSON.stringify(existing.manifest.branding, null, 2)}
\`\`\`

${historyBlock ? `## Earlier turns in this edit session\n${historyBlock}\n\n` : ''}## User instruction
${input.instruction}

## Your job
Return the updated script (and branding when relevant) along with a one-line summary of what you changed.

RULES:
- Preserve the overall structure: hook → scenes → cta. Don't add or remove scenes unless the user explicitly asks.
- Keep totalDurationSeconds === hook.durationSeconds + sum(scenes[].durationSeconds) + cta.durationSeconds.
- Keep word counts realistic at ~2.3 words/sec for voice-over text.
- When editing mockCode, keep it valid TSX that renders a single React element.
- Only change what the instruction asks for. Leave the rest verbatim.
- If the instruction is unclear or impossible, return the manifest unchanged and explain in the message.
- Voice-over audio + music URLs are NOT yours to change — those are regenerated separately.

Return ONLY valid JSON matching the response schema.`

  // Try Pro first for better edit reasoning, fall back to Flash on
  // 503 / overload / 429. Pro has visible quality lift on "rewrite the
  // CTA in french while keeping the playful tone" but Flash handles
  // most edits acceptably and is the right pressure-relief when Google
  // returns "model currently experiencing high demand". Without this,
  // a busy Pro cluster blocks every iteration on the editor.
  let result: { text: string }
  try {
    result = await generateText({
      userPrompt: prompt,
      model: GEMINI_PRO_MODEL,
      maxTokens: 16_384,
      temperature: 0.4,
      json: true,
    })
  } catch (err) {
    const message = (err as Error).message ?? ''
    const status = (err as { status?: number }).status
    const isOverload = status === 503 || status === 429
      || /high demand|overload|temporarily unavailable|rate.?limit/i.test(message)
    if (!isOverload) throw err
    console.warn(`[marketing-edit] Pro overloaded (${status ?? 'no-status'}), falling back to Flash`)
    result = await generateText({
      userPrompt: prompt,
      // No model override → uses default Flash from gemini.client.
      maxTokens: 16_384,
      temperature: 0.4,
      json: true,
    })
  }

  // Parse defensively — even with responseMimeType:application/json the
  // model occasionally wraps the answer in markdown fences.
  let parsed: { message?: string; script?: unknown; branding?: unknown }
  try {
    let text = result.text.trim()
    if (text.startsWith('```')) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start !== -1 && end > start) text = text.slice(start, end + 1)
    parsed = JSON.parse(text) as typeof parsed
  } catch (err) {
    throw new Error(`AI returned invalid JSON: ${(err as Error).message}`)
  }

  if (!parsed.script) {
    // No script field → AI bailed (instruction unclear / impossible).
    // Surface the message but don't touch the manifest.
    return {
      summary: existing,
      message: parsed.message ?? "I couldn't apply that change. Try rephrasing or be more specific.",
    }
  }

  const { UpdateMarketingManifestSchema } = await import('./marketing-video.schema.js')
  const validated = UpdateMarketingManifestSchema.safeParse({
    script: parsed.script,
    ...(parsed.branding ? { branding: parsed.branding } : {}),
  })
  if (!validated.success) {
    throw new Error(`AI produced an invalid manifest: ${JSON.stringify(validated.error.flatten().fieldErrors).slice(0, 300)}`)
  }

  // Recompile any mockCode the AI rewrote — Remotion runs the compiled
  // output, not the TSX source.
  const { compileMockCode } = await import('./mock-code.compiler.js')
  for (const scene of validated.data.script.scenes) {
    if (scene.mockCode && scene.mockCode.length > 0) {
      try {
        const c = await compileMockCode(scene.mockCode)
        scene.mockCompiledCode = c.compiled
      } catch (err) {
        // Drop the new mockCode + its compiled output if the AI emitted
        // something that won't compile — better to keep the previous
        // visual than break the render.
        console.warn(`[marketing-edit] mockCode compile failed, dropping: ${(err as Error).message}`)
        scene.mockCode = undefined
        scene.mockCompiledCode = undefined
      }
    }
  }

  const summary = await updateMarketingManifestForRun(runId, validated.data)
  return {
    summary,
    message: parsed.message ?? 'Manifest updated.',
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
