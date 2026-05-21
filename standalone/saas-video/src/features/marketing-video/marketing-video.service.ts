import { getPublicUrl, uploadToStorage } from '../../shared/db/storage.repository.js'
import { synthesizeSpeech, generateMusic, isElevenLabsConfigured } from '../../shared/ai/elevenlabs.client.js'
import { generateMarketingScript } from './marketing-script.generator.js'
import { computeTotalDuration } from './marketing-video.schema.js'
import {
  getMarketingVideoById,
  updateMarketingVideo,
} from './marketing-video.repository.js'
import { getBrandById } from '../brand/brand.repository.js'
import type { Brand } from '../brand/brand.types.js'
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
  punchy:         'Energetic upbeat marketing music, electronic, driving rhythm, modern, confident',
  calm:           'Calm ambient background music, minimal piano, professional, soft pads',
  playful:        'Fun upbeat marketing music, playful melodies, light percussion, optimistic',
  serious:        'Subtle cinematic background music, building tension, professional, restrained',
  confident:      'Warm modern marketing music, mid-tempo electronic with acoustic elements, hopeful, founder-pitch energy',
  inspirational:  'Uplifting orchestral marketing music, building strings, swelling crescendo, motivational, anthemic',
  conversational: 'Mellow lo-fi marketing music, soft beats, jazzy keys, relaxed podcast vibe, warm and approachable',
}

/** Curated AI music styles surfaced as their own dropdown options. Each
 *  one routes through the same ElevenLabs Music endpoint but with a
 *  distinct prompt so the user can pick a vibe directly without writing
 *  a brief. The keys here are the dropdown ids (prefixed `ai-` to
 *  distinguish from hosted presets if we ever add them); the values are
 *  the prompts. The default `'ai'` choice still works and uses the
 *  tone-mapped prompt above. */
export const AI_MUSIC_STYLES: Record<string, { name: string; prompt: string; mood?: string }> = {
  'ai-cinematic': {
    name: 'Cinematic',
    mood: 'Dramatic, building',
    prompt: 'Cinematic marketing music, layered orchestral strings, building tension, deep bass swells, modern epic, instrumental',
  },
  'ai-upbeat': {
    name: 'Upbeat',
    mood: 'Energetic, modern',
    prompt: 'Upbeat marketing music, driving electronic beat, bright synths, modern pop production, confident and energetic, instrumental',
  },
  'ai-lofi': {
    name: 'Lo-fi',
    mood: 'Relaxed, study-vibe',
    prompt: 'Lo-fi hip hop marketing music, mellow beats, jazzy keys, vinyl crackle, warm and approachable, instrumental',
  },
  'ai-ambient': {
    name: 'Ambient',
    mood: 'Minimal, professional',
    prompt: 'Ambient marketing music, sparse piano notes, soft pads, gentle atmosphere, professional and minimal, instrumental',
  },
  'ai-synthwave': {
    name: 'Synthwave',
    mood: 'Retro, neon',
    prompt: 'Synthwave marketing music, retro 80s synths, driving arpeggios, neon energy, modern nostalgic, instrumental',
  },
  'ai-acoustic': {
    name: 'Acoustic',
    mood: 'Warm, organic',
    prompt: 'Acoustic marketing music, fingerpicked guitar, soft percussion, warm and human, approachable indie vibe, instrumental',
  },
  'ai-tech': {
    name: 'Tech',
    mood: 'Pulsing, modern',
    prompt: 'Tech marketing music, pulsing electronic rhythm, glassy synths, futuristic, clean and modern, instrumental',
  },
  'ai-inspirational': {
    name: 'Inspirational',
    mood: 'Uplifting, anthemic',
    prompt: 'Inspirational marketing music, swelling strings, building crescendo, uplifting piano, motivational anthemic, instrumental',
  },
  'ai-playful': {
    name: 'Playful',
    mood: 'Cheeky, light',
    prompt: 'Playful marketing music, bouncy melodies, light percussion, ukulele or marimba, cheeky and optimistic, instrumental',
  },
  'ai-dark': {
    name: 'Dark',
    mood: 'Brooding, intense',
    prompt: 'Dark marketing music, brooding bass, haunting pads, tense atmosphere, modern thriller score, instrumental',
  },
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
  punchy:         { stability: 0.20, style: 0.90, similarityBoost: 0.75 },
  calm:           { stability: 0.55, style: 0.35, similarityBoost: 0.80 },
  playful:        { stability: 0.15, style: 0.90, similarityBoost: 0.70 },
  serious:        { stability: 0.55, style: 0.25, similarityBoost: 0.85 },
  // Confident: warm authority — moderate stability + medium style for
  //   variation without bouncing too much. Founder-pitch energy.
  confident:      { stability: 0.40, style: 0.55, similarityBoost: 0.80 },
  // Inspirational: builds — needs dynamic range. Low stability + high
  //   style for swelling delivery on the climax phrases.
  inspirational:  { stability: 0.25, style: 0.80, similarityBoost: 0.78 },
  // Conversational: natural delivery — high similarity to the base
  //   voice, low style so it doesn't perform. Reads like a podcast host.
  conversational: { stability: 0.45, style: 0.30, similarityBoost: 0.85 },
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
  websiteUrl: null,
  radius: 14,
}

/** Derive a clean origin URL from `project.baseUrl` (which may include a
 *  path, query, or trailing slash). Returns null when baseUrl is empty or
 *  unparseable so the renderer can fall back to its heuristic. */
function deriveWebsiteUrl(rawBaseUrl: string | null | undefined): string | null {
  if (!rawBaseUrl || rawBaseUrl.trim().length === 0) return null
  try {
    const u = new URL(rawBaseUrl)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
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
 * Build the per-video branding bundle Remotion uses for colors, fonts, and
 * the product logo. Takes a Brand row from the `brands` table — the user's
 * onboarding step persists this and every video references one explicitly.
 * Falls back to DEFAULT_BRANDING only if the row is somehow null (defensive).
 */
function brandToBranding(brand: Brand | null): MarketingBranding {
  if (!brand) return DEFAULT_BRANDING
  return {
    productName: brand.name,
    accentColor: brand.accentColor,
    bgColor: brand.bgColor,
    textColor: brand.textColor,
    fontFamily: brand.fontFamily,
    logoUrl: brand.logoUrl,
    websiteUrl: deriveWebsiteUrl(brand.websiteUrl),
  }
}

/**
 * Standalone product never has real screenshots — visualMode is always
 * 'mocks'. Kept as a function (rather than inlining `[]`) so the call sites
 * downstream stay structurally identical to the Doclee source. If we later
 * add a "drop a few screenshots to ground the script" feature, this is the
 * single seam to wire it in.
 */
async function collectScreenshots(_videoId: string): Promise<MarketingScreenshot[]> {
  return []
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
  videoId: string,
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
  const voiceoverPath = `videos/${videoId}/marketing-voiceover.mp3`
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
 * Deterministic, hand-written fallback mock used when every Gemini path
 * (initial generate, rescue retry, Pro→Flash fallback) fails to produce
 * compilable TSX for a scene. Reveals the headline word-by-word against
 * the canvas bgColor — no model, no surprises, no failure mode. Better
 * to ship a clean typographic scene than a blank panel.
 */
async function applyDeterministicFallback(
  scene: { headline: string; mockCode?: string; mockCompiledCode?: string },
  compile: (src: string) => Promise<{ compiled: string }>,
): Promise<void> {
  try {
    const tsx = buildFallbackMockTsx(scene.headline)
    const { compiled } = await compile(tsx)
    scene.mockCode = tsx
    scene.mockCompiledCode = compiled
  } catch (err) {
    console.error(`[marketing-video] Deterministic fallback compile failed for "${scene.headline}": ${(err as Error).message}`)
    scene.mockCode = undefined
    scene.mockCompiledCode = undefined
  }
}

function buildFallbackMockTsx(headline: string): string {
  // Escape backticks/backslashes/${} so a stray quoted name doesn't
  // break the template literal in the generated source.
  const safe = headline
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
  return `function MockScene({ branding }) {
  const f = Remotion.useCurrentFrame()
  const { fps } = Remotion.useVideoConfig()
  const words = ${JSON.stringify(safe)}.split(/\\s+/).filter(Boolean)
  return (
    <Remotion.AbsoluteFill className='flex items-center justify-center p-12'>
      <div className='flex flex-wrap items-center justify-center gap-x-4 gap-y-2 max-w-[80%]'>
        {words.map((w, i) => {
          const t = Remotion.spring({ frame: f - i * 6, fps, config: { damping: 18, stiffness: 110 } })
          const op = Remotion.interpolate(t, [0, 1], [0, 1])
          const y = Remotion.interpolate(t, [0, 1], [18, 0])
          return (
            <span
              key={i}
              style={{
                opacity: op,
                transform: \`translateY(\${y}px)\`,
                color: i % 3 === 1 ? branding.accentColor : branding.textColor,
                fontFamily: branding.fontFamily,
                fontSize: 84,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
              }}
            >
              {w}
            </span>
          )
        })}
      </div>
    </Remotion.AbsoluteFill>
  )
}`
}


/**
 * Full marketing-video pipeline: pulls the doc + branding + screenshots,
 * asks Gemini for a 60s script, synthesizes the narration via ElevenLabs
 * (optional), uploads the audio, and persists a manifest on the run summary.
 *
 * The manifest is what Remotion consumes to render. Server-side render is
 * NOT in this MVP — call `npm run marketing:preview <videoId>` to iterate the
 * template locally with the manifest fed in.
 */
export async function generateMarketingVideo(
  videoId: string,
  options: GenerateMarketingVideoOptions = {},
): Promise<MarketingVideoSummary> {
  // Mark the row as in flight up front. Combined with the partial unique
  // index on render_status, this also reserves the per-user concurrency
  // slot — a second concurrent call from the same user trips the index
  // and fails fast at the DB layer.
  const video = await getMarketingVideoById(videoId)
  await updateMarketingVideo(videoId, { renderStatus: 'generating', renderError: null })

  const brief = video.brief.trim()
  if (!brief) {
    throw new Error('Marketing video has no brief. The row should never be created without one.')
  }
  const sourceMarkdown = brief
  const pageTitle = video.title || 'Marketing video'

  const brand = await getBrandById(video.brandId)
  const branding = brandToBranding(brand)
  // Standalone product always uses 'mocks' visualMode — no screenshots.
  const screenshots = await collectScreenshots(videoId)
  const language = detectLanguage(sourceMarkdown)

  console.log(`[marketing-video] Video ${videoId}: lang=${language}, product="${branding.productName}"`)

  // visualMode is always 'mocks' in standalone — no screenshots to ground
  // scenes in. Kept as a const (rather than threading options.visualMode)
  // so the downstream code doesn't have a branch that can never fire.
  const effectiveVisualMode: 'mocks' = 'mocks'

  const script = await generateMarketingScript({
    productName: branding.productName,
    pageTitle,
    pageMarkdown: sourceMarkdown,
    availableScreenshots: screenshots.length,
    screenshotCaptions: screenshots.map((s) => s.caption),
    language,
    // Same tone drives both the script (which audio tags to embed) and
    // the voice (ElevenLabs settings). Without this the script comes out
    // flat and even an expressive voice setting reads it flat.
    tone: options.tone ?? 'punchy',
    visualMode: effectiveVisualMode,
    userPrompt: options.userPrompt,
  })

  // Derive total from the parts so a script with a stale / missing
  // `totalDurationSeconds` stays internally consistent. Snapshot it back
  // onto the script so the persisted manifest carries an authoritative
  // value (the renderer derives at render-time anyway, but tooling /
  // edit prompts read this directly).
  script.totalDurationSeconds = computeTotalDuration(script)
  console.log(`[marketing-video] Script: ${script.scenes.length} scenes, ${script.totalDurationSeconds.toFixed(2)}s total`)

  // Per-scene TSX compile + rescue loop. Two failure modes routed
  // through the same path:
  //   1. mockCode missing entirely (model exhausted token budget,
  //      skipped the scene). Send to repairMockCode in "from scratch"
  //      mode → it generates a fresh MockScene from the headline +
  //      voice-over.
  //   2. mockCode present but compile/lint fails. Send to
  //      repairMockCode with the error → it rewrites with the fix.
  // Both rescues failed → applyDeterministicFallback ships a hand-
  // written hero-text TSX so the scene still renders something.
  if (effectiveVisualMode === 'mocks') {
    const { compileMockCode } = await import('./mock-code.compiler.js')
    const { repairMockCode } = await import('./marketing-script.generator.js')

    for (const scene of script.scenes) {
      const missingMock = !scene.mockCode || scene.mockCode.trim().length === 0
      if (missingMock) {
        console.warn(`[marketing-video] mockCode missing for scene "${scene.headline}" — generating one`)
        try {
          const generated = await repairMockCode({
            scene: { headline: scene.headline, voiceover: scene.voiceover, mockCode: '' },
            compileError: 'mockCode was missing — the script generator skipped this scene (likely token budget exhaustion). Generate a NEW MockScene from scratch that illustrates the headline + voice-over.',
          })
          const { compiled } = await compileMockCode(generated)
          scene.mockCode = generated
          scene.mockCompiledCode = compiled
          console.log(`[marketing-video] Backfilled mockCode for scene "${scene.headline}"`)
        } catch (err) {
          console.warn(`[marketing-video] Backfill failed for scene "${scene.headline}": ${(err as Error).message} — using deterministic fallback`)
          await applyDeterministicFallback(scene, compileMockCode)
        }
        continue
      }
      try {
        const { compiled } = await compileMockCode(scene.mockCode!)
        scene.mockCompiledCode = compiled
      } catch (err) {
        const firstErr = (err as Error).message
        console.warn(`[marketing-video] mockCode compile failed for scene "${scene.headline}": ${firstErr} — attempting one rescue`)
        try {
          const rescued = await repairMockCode({
            scene: { headline: scene.headline, voiceover: scene.voiceover, mockCode: scene.mockCode! },
            compileError: firstErr,
          })
          const { compiled } = await compileMockCode(rescued)
          scene.mockCode = rescued
          scene.mockCompiledCode = compiled
          console.log(`[marketing-video] Rescued mockCode for scene "${scene.headline}"`)
        } catch (rescueErr) {
          console.warn(`[marketing-video] Rescue also failed for scene "${scene.headline}": ${(rescueErr as Error).message} — using deterministic fallback`)
          await applyDeterministicFallback(scene, compileMockCode)
        }
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
    const result = await synthesizeMarketingVoiceover(videoId, script, options)
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
    } else if (options.musicTrackId === 'ai' || (options.musicTrackId && options.musicTrackId.startsWith('ai-'))) {
      // Two AI paths converge on the same ElevenLabs Music call:
      //   - 'ai' → tone-mapped prompt + optional user brief (legacy default)
      //   - 'ai-<style>' → style-specific prompt from AI_MUSIC_STYLES,
      //     still extendable with the user's brief.
      if (!isElevenLabsConfigured()) {
        throw new Error('ELEVENLABS_API_KEY is required for AI music generation.')
      }
      const tone = options.tone ?? 'punchy'
      const styleId = options.musicTrackId
      let musicPrompt: string
      if (styleId !== 'ai' && AI_MUSIC_STYLES[styleId]) {
        const style = AI_MUSIC_STYLES[styleId]!
        const userBrief = options.aiMusicPrompt?.trim()
        musicPrompt = userBrief
          ? `${style.prompt}, ${userBrief}. Background music for a ${branding.productName} marketing video.`
          : `${style.prompt}. Background music for a ${branding.productName} marketing video.`
      } else {
        musicPrompt = buildMusicPrompt(tone, options.aiMusicPrompt, branding.productName)
      }
      const durationMs = Math.round(computeTotalDuration(script) * 1000)
      console.log(`[marketing-video] Music: AI-generating (${styleId}), durationMs=${durationMs}`)
      const buffer = await generateMusic(musicPrompt, { durationMs })
      musicPath = `videos/${videoId}/marketing-music-ai.mp3`
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
    videoId,
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

  // Persist the manifest in storage so the render service can fetch by URL
  // without going through the API, AND in the DB so the gallery doesn't
  // need a second round-trip to read it back. The storage copy is the one
  // Remotion reads; the DB copy is the one our app reads.
  const manifestPath = `videos/${videoId}/marketing-manifest.json`
  await uploadToStorage(
    'artifacts',
    manifestPath,
    Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
    'application/json',
  )
  const manifestUrl = `${getPublicUrl('artifacts', manifestPath) ?? ''}?v=${Date.now()}`

  await updateMarketingVideo(videoId, {
    manifest,
    renderStatus: 'rendering',  // about to hand off to the render service
    renderError: null,
  })

  const summary: MarketingVideoSummary = {
    manifest,
    manifestUrl,
    videoUrl: null,
    videoPath: null,
    renderStatus: 'idle',
    renderError: null,
  }

  return summary
}

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
  videoId: string,
  options: { voiceId?: string; tone?: import('./marketing-video.types.js').VoiceTone },
): Promise<MarketingVideoSummary> {
  const { findMarketingVideoByRunId, saveMarketingVideo } = await import('./marketing-video.repository.js')
  const existing = await findMarketingVideoByRunId(videoId)
  if (!existing) throw new Error('No marketing-video manifest for this run yet — generate one first.')

  const { voiceoverPath, voiceoverUrl, voiceoverDurationSeconds } = await synthesizeMarketingVoiceover(
    videoId,
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
  const manifestPath = `videos/${videoId}/marketing-manifest.json`
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
  await saveMarketingVideo(videoId, updated)
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
  videoId: string,
  patch: import('./marketing-video.schema.js').UpdateMarketingManifestInput,
): Promise<MarketingVideoSummary> {
  const { findMarketingVideoByRunId, saveMarketingVideo } = await import('./marketing-video.repository.js')
  const existing = await findMarketingVideoByRunId(videoId)
  if (!existing) throw new Error('No marketing-video manifest for this run yet — generate one first.')

  // Cast through `as` because the schema's inferred type uses a permissive
  // MockElement shape (`type: z.string()`) — the discriminated-union types
  // in marketing-video.types.ts are stricter. The Zod validator already
  // gated the runtime shape; the cast just bridges the structural gap.
  const updatedManifest: MarketingManifest = {
    ...existing.manifest,
    script: patch.script as MarketingManifest['script'],
    ...(patch.screenshots ? { screenshots: patch.screenshots } : {}),
    // Merge partial branding patches with the existing branding so the
    // model can change just one field (e.g. accentColor) without having
    // to re-emit the whole branding object. The Zod schema accepts a
    // partial; we layer it on top of `existing.manifest.branding`.
    ...(patch.branding
      ? { branding: { ...existing.manifest.branding, ...patch.branding } }
      : {}),
    ...(typeof patch.musicVolume === 'number' ? { musicVolume: patch.musicVolume } : {}),
    generatedAt: new Date().toISOString(),
  }

  const manifestPath = `videos/${videoId}/marketing-manifest.json`
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
  await saveMarketingVideo(videoId, updated)
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
  videoId: string,
  input: {
    instruction: string
    history?: { role: 'user' | 'assistant'; content: string }[]
  },
): Promise<{ summary: MarketingVideoSummary; message: string }> {
  const { findMarketingVideoByRunId } = await import('./marketing-video.repository.js')
  const existing = await findMarketingVideoByRunId(videoId)
  if (!existing) throw new Error('No marketing-video manifest for this video yet — generate one first.')

  // The edit follows the same architect / designer split as fresh
  // generation: the editor LLM works as the ARCHITECT — it edits the
  // text + per-scene visualBrief / visualMode but NEVER writes
  // mockCode itself. After the edit returns, scenes whose brief
  // actually changed get their mockCode regenerated by the designer
  // (one parallel call per scene). Past monolithic edit prompts
  // dropped mockCode for 3/4 scenes when asked to regen — token
  // budget + attention drift in a single 32k call. This split is
  // strictly more reliable.
  const editableScript = {
    ...existing.manifest.script,
    scenes: existing.manifest.script.scenes.map((s) => ({
      ...s,
      // Strip mockCode + mockCompiledCode: the editor never sees them
      // (anchoring + token bloat), the designer regenerates them
      // from the brief afterward.
      mockCode: undefined,
      mockCompiledCode: undefined,
    })),
  }

  const historyBlock = (input.history ?? [])
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')

  const prompt = `You are the ARCHITECT editing a marketing video manifest based on a user instruction. A separate DESIGNER agent regenerates the per-scene TSX animation from the visualBrief you write — you DO NOT write mockCode yourself.

## Product
${existing.manifest.branding.productName}

## Current manifest script (mockCode stripped — designer handles that)
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
Return the updated script (and branding when relevant) along with a one-line summary of what you changed. Per scene, the fields that drive the mockCode regen are \`visualMode\` + \`visualBrief\` — make sure they reflect the user's intent.

## ⚠ NON-NEGOTIABLE OUTPUT CONTRACT — READ THIS FIRST

Your response MUST contain a complete \`script\` object with EVERY field present. The downstream Zod validator throws on a single missing field and aborts the whole edit.

**Required shape (no exceptions):**
\`\`\`json
{
  "message": "<one-line summary>",
  "script": {
    "language": "<existing language code>",
    "totalDurationSeconds": <number>,
    "styleSeed": "<existing label, or a new STYLE_SEEDS label if the user asked for an aesthetic shift>",
    "hook": {
      "voiceover": "<string>",
      "headline": "<string>",
      "durationSeconds": <number>
    },
    "scenes": [
      {
        "voiceover": "<string>",
        "headline": "<string>",
        "subhead": "<string or omit if originally absent>",
        "screenshotIndex": <number or null>,
        "durationSeconds": <number>,
        "visualMode": "<one of: hero-stat | bento | chat | chart | cursor-click | flow-diagram | headline-burst | logo-hero | custom>",
        "visualBrief": "<2-3 sentences naming SPECIFIC elements / numbers / words / motion the designer will put on screen. The designer ONLY sees this brief + the headline/voiceover, so be concrete: exact text, focal element, motion idea.>",
        "framing": "<optional: browser | mobile | terminal | fullbleed | split — cadrage of the mock itself.>",
        "headlinePanel": "<optional boolean. Default true. Set false to suppress the composition's headline panel and let the mock fill the full 1920×1080 canvas — voice-over carries the story. Orthogonal to framing.>"
      }
      // ... one entry per existing scene, SAME ORDER
    ],
    "cta": {
      "voiceover": "<string>",
      "headline": "<string>",
      "buttonLabel": "<string>",
      "durationSeconds": <number>
    }
  },
  "branding": { /* optional, partial patch with ONLY the fields you actually want to change */ }
}
\`\`\`

**Common failures to avoid:**

1. **Writing mockCode.** DO NOT include a \`mockCode\` field on any scene. The designer regenerates from your visualBrief — your mockCode would be ignored AND would bloat the response, dropping fields the validator needs.

2. **Dropping per-scene fields.** When you rewrite \`visualBrief\` for a creative refine, you forget to copy \`durationSeconds\` / \`screenshotIndex\` / \`headline\` from the existing scene → validator sees \`undefined\` → edit aborts. Carry every existing field through, then layer your changes on top.

3. **Total duration math.** Doclee derives \`totalDurationSeconds\` from \`hook.durationSeconds + sum(scenes[].durationSeconds) + cta.durationSeconds\`. You MAY omit \`totalDurationSeconds\` entirely; if you include it, an inconsistent value is overridden (no longer rejected). What matters is the per-part durations adding up to ~45s.

4. **Null instead of omit on branding.** \`branding\` is a partial patch: include ONLY the fields you want to change. Don't set unchanged fields to \`null\` to "signal no change". \`{ "branding": { "accentColor": "#0070f3" } }\` is correct. \`{ "branding": { "accentColor": "#0070f3", "bgColor": null } }\` is WRONG. If branding is unchanged, omit the whole \`branding\` key.

## Edit philosophy
The user gives you a **direction**, not a diff. Read it for INTENT.
- **Surgical instructions** ("change X to Y", "shorten scene 2", "swap the icon") → minimal diff. Touch only the asked-for fields, leave the rest verbatim. The visualBrief stays the same for untouched scenes — that means the designer keeps the existing mockCode (we detect "brief unchanged" and skip regen).
- **Creative instructions** ("plus d'animations", "plus wahou", "rends plus dynamic", "more punch", "make it pop", "plus moderne") → REWRITE the affected scenes' \`visualBrief\` aggressively with new motion ideas, layout shifts, focal elements. Briefs like "card pulses with a glow + counter ticks live + parallax accent block in the corner" trigger the designer to compose a richer scene. Don't be timid — the user wants visibly different output.
- **Aesthetic shifts** ("plus editorial", "plus brutalist", "less violet") → update \`styleSeed\` to one of: editorial, product-tour, metric-driven, process-flow, brand-first, conversational, high-contrast, data-density. AND update branding.accentColor if "less violet" / "more orange" etc.
- **Mode changes** ("make scene 2 a chat instead of bento") → set the new visualMode and rewrite the visualBrief to suit it.

## Rules
- Preserve scene COUNT and ORDER (don't add/remove scenes unless explicitly asked).
- Keep \`totalDurationSeconds\` consistent with the parts.
- Keep word counts realistic at ~2.3 words/sec for voice-over.
- DO NOT write \`mockCode\`. Only update the fields above.
- Voice-over audio + music URLs are NOT yours to change — those are regenerated separately.
- If the instruction is unclear or impossible, return \`{ "message": "<explanation>" }\` WITHOUT a \`script\` field. The manifest stays unchanged.

Return ONLY valid JSON: { "message": string, "script": <full edited script>, "branding"?: <patch> }.`

  // Architect edit on Sonnet 4.6 — same model as the fresh-gen
  // architect, for consistency. Plain text with defensive JSON parsing
  // (the prompt asks for JSON-only output; defensive parser below
  // handles markdown fences / prose drift). No retry — Anthropic SDK
  // auto-retries 429/5xx; on a hard refusal the catch in the calling
  // route surfaces the error. No tool-use schema: the response shape
  // is tightly constrained by the prompt + downstream Zod validation,
  // and a tool-use input_schema would have to mirror MarketingScript
  // verbatim (large + drift risk on schema updates).
  const { generateSonnetText, HAIKU_MODEL } = await import('../../shared/ai/anthropic.client.js')
  const result = await generateSonnetText({
    userPrompt: prompt,
    // Refine architect on Haiku 4.5 — structured JSON output + short
    // text edits, not TSX composition. ~3× cheaper than Sonnet for the
    // same shape of work. The per-scene mockCode regen still calls
    // generateSceneMockCode / repairMockCode which stay on Sonnet.
    model: HAIKU_MODEL,
    maxTokens: 16_000,
    temperature: 0.4,
  })

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

  // Diagnostic log: what shape did the AI actually return?
  const aiScript = parsed.script as Record<string, unknown> | undefined
  const aiTopKeys = aiScript ? Object.keys(aiScript) : []
  const aiScenes = (aiScript?.scenes as Array<Record<string, unknown>> | undefined) ?? []
  const sceneFieldSummary = aiScenes.map((s, i) => {
    const fields = Object.keys(s)
    const required = ['voiceover', 'headline', 'screenshotIndex', 'durationSeconds']
    const missing = required.filter((k) => !(k in s) || s[k] === undefined)
    return `[${i}] keys=${fields.join(',')}${missing.length ? ` MISSING=${missing.join(',')}` : ''}`
  })
  console.log(`[marketing-edit] AI output shape: top=${aiTopKeys.join(',')} scenes=${aiScenes.length}`)
  console.log(`[marketing-edit] AI scenes:\n  ${sceneFieldSummary.join('\n  ')}`)

  const { UpdateMarketingManifestSchema } = await import('./marketing-video.schema.js')
  const validated = UpdateMarketingManifestSchema.safeParse({
    script: parsed.script,
    ...(parsed.branding ? { branding: parsed.branding } : {}),
  })
  if (!validated.success) {
    console.error('[marketing-edit] Zod issues (full):', JSON.stringify(validated.error.issues, null, 2))
    console.error('[marketing-edit] AI raw text (first 2000 chars):', result.text.slice(0, 2000))
    throw new Error(`AI produced an invalid manifest: ${JSON.stringify(validated.error.flatten().fieldErrors).slice(0, 300)}`)
  }

  // Per-scene mockCode resolution. Three paths per scene:
  //   1. Brief / mode / headline / voiceover unchanged from existing →
  //      keep the existing mockCode + mockCompiledCode (no regen).
  //   2. Anything that drives the visual changed → regenerate via the
  //      designer call (parallel across scenes).
  //   3. Compile fails → repairMockCode rescue, else deterministic fallback.
  //
  // Comparing visualBrief / visualMode (in addition to headline /
  // voiceover) means the user's "make scene 2 a chat" instruction
  // triggers regen even if the headline didn't change.
  const { compileMockCode } = await import('./mock-code.compiler.js')
  const { repairMockCode, regenerateSceneMockCode } = await import('./marketing-script.generator.js')
  const productName = existing.manifest.branding.productName
  const styleSeedLabel = validated.data.script.styleSeed ?? existing.manifest.script.styleSeed
  const editedScenes = validated.data.script.scenes
  const existingScenes = existing.manifest.script.scenes

  const sceneVisualUnchanged = (a: typeof editedScenes[number], b: typeof existingScenes[number]): boolean => {
    return (
      a.headline === b.headline &&
      a.voiceover === b.voiceover &&
      (a.visualMode ?? '') === (b.visualMode ?? '') &&
      (a.visualBrief ?? '') === (b.visualBrief ?? '') &&
      (a.framing ?? '') === (b.framing ?? '') &&
      (a.headlinePanel ?? true) === (b.headlinePanel ?? true)
    )
  }

  const regenTasks = editedScenes.map(async (scene, i) => {
    const prev = existingScenes[i]
    if (prev && sceneVisualUnchanged(scene, prev) && prev.mockCode && prev.mockCompiledCode) {
      // Surgical edit didn't touch this scene's visuals — keep the
      // existing compiled mockCode verbatim.
      scene.mockCode = prev.mockCode
      scene.mockCompiledCode = prev.mockCompiledCode
      return
    }

    // Brief / mode / headline / voiceover changed — regenerate.
    try {
      const fresh = await regenerateSceneMockCode({
        scene: {
          headline: scene.headline,
          voiceover: scene.voiceover,
          subhead: scene.subhead,
          durationSeconds: scene.durationSeconds,
          visualMode: scene.visualMode,
          visualBrief: scene.visualBrief,
          framing: scene.framing,
          headlinePanel: scene.headlinePanel,
        },
        productName,
        styleSeedLabel: styleSeedLabel ?? undefined,
      })
      const compiled = await compileMockCode(fresh)
      scene.mockCode = fresh
      scene.mockCompiledCode = compiled.compiled
    } catch (firstErr) {
      const msg = (firstErr as Error).message
      console.warn(`[marketing-edit] Regen / compile failed for scene "${scene.headline}": ${msg} — attempting one rescue`)
      try {
        const rescued = await repairMockCode({
          scene: { headline: scene.headline, voiceover: scene.voiceover, mockCode: '' },
          compileError: `Regen failed: ${msg}. Generate a fresh MockScene from the headline + voice-over + brief: ${scene.visualBrief ?? '(no brief)'}.`,
        })
        const compiled = await compileMockCode(rescued)
        scene.mockCode = rescued
        scene.mockCompiledCode = compiled.compiled
      } catch (rescueErr) {
        console.warn(`[marketing-edit] Rescue also failed for scene "${scene.headline}": ${(rescueErr as Error).message} — using deterministic fallback`)
        await applyDeterministicFallback(scene, compileMockCode)
      }
    }
  })
  await Promise.all(regenTasks)

  const summary = await updateMarketingManifestForRun(videoId, validated.data)
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
/**
 * Persist a thumbnail JPEG for the rendered video. Captured client-side
 * by the panel after the first video load (see MarketingVideoPanel) — the
 * frame at 4s sits at the end of the hook with the headline locked in,
 * which makes a punchy social card. Server stores it under the run's
 * artifacts and patches the manifest's thumbnailUrl + thumbnailPath.
 *
 * Doesn't reset renderStatus (unlike updateMarketingManifestForRun) —
 * the thumbnail is a side artifact, not a manifest change.
 */
export async function setMarketingThumbnailForRun(
  videoId: string,
  jpegBase64: string,
): Promise<{ thumbnailUrl: string; thumbnailPath: string }> {
  const { findMarketingVideoByRunId, saveMarketingVideo } = await import('./marketing-video.repository.js')
  const existing = await findMarketingVideoByRunId(videoId)
  if (!existing) {
    throw new Error('No marketing-video manifest for this run yet.')
  }
  // Strip the data: URL prefix if the client included it.
  const cleanBase64 = jpegBase64.replace(/^data:image\/\w+;base64,/, '')
  const buffer = Buffer.from(cleanBase64, 'base64')
  // Sanity check: refuse anything beyond ~2MB so a malicious or buggy
  // client can't blow up Storage. A 1080p JPEG at quality 0.85 is
  // ~200-400KB; 2MB is comfortable headroom.
  if (buffer.byteLength > 2 * 1024 * 1024) {
    throw new Error(`Thumbnail too large: ${buffer.byteLength} bytes (cap 2MB)`)
  }
  const thumbnailPath = `videos/${videoId}/marketing-thumbnail.jpg`
  await uploadToStorage('artifacts', thumbnailPath, buffer, 'image/jpeg')
  const thumbnailUrl = `${getPublicUrl('artifacts', thumbnailPath) ?? ''}?v=${Date.now()}`

  await saveMarketingVideo(videoId, {
    ...existing,
    manifest: { ...existing.manifest, thumbnailUrl, thumbnailPath },
  })

  console.log(`[marketing-video] Thumbnail uploaded: ${thumbnailUrl} (${buffer.byteLength} bytes)`)
  return { thumbnailUrl, thumbnailPath }
}

export async function renderMarketingVideoForRun(
  videoId: string,
): Promise<MarketingVideoSummary> {
  const { findMarketingVideoByRunId, saveMarketingVideo } = await import('./marketing-video.repository.js')
  const existing = await findMarketingVideoByRunId(videoId)
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
  await saveMarketingVideo(videoId, {
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
      // The video-service wire protocol still uses `runId` as the field
      // name on the render request — pass our videoId in that slot rather
      // than renaming the protocol (the Remotion render service is shared
      // with Doclee and shipping a protocol change is out of scope here).
      runId: videoId,
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
    await saveMarketingVideo(videoId, ready)
    return ready
  } catch (err) {
    const failed: MarketingVideoSummary = {
      ...existing,
      renderStatus: 'failed',
      renderError: (err as Error).message,
    }
    await saveMarketingVideo(videoId, failed)
    throw err
  }
}
