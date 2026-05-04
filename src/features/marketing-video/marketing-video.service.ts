import { findRunById } from '../run/run.repository.js'
import { findStepsByRunId } from '../run/run.repository.js'
import { findPageById } from '../page/page.repository.js'
import { getPublicUrl, uploadToStorage } from '../../shared/db/storage.repository.js'
import { synthesizeSpeech, generateMusic, isElevenLabsConfigured } from '../../shared/ai/elevenlabs.client.js'
import { NotFoundError } from '../../shared/middleware/error.middleware.js'
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
    <Remotion.AbsoluteFill className='flex items-center justify-center p-12' style={{ background: branding.bgColor }}>
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

  // Server-side guard: visualMode='screenshots' is meaningless when the
  // run has no screenshots available — every scene would emit
  // `screenshotIndex: null` and the renderer would fall back to a blank
  // bgColor canvas. Auto-promote to 'mocks' so we always produce visible
  // scenes. The conversational pre-flight is supposed to default to
  // mocks but the AI picks 'screenshots' sometimes; this is the safety
  // net regardless of where the request came from.
  const requestedVisualMode = options.visualMode ?? 'screenshots'
  const effectiveVisualMode: 'mocks' | 'screenshots' =
    requestedVisualMode === 'screenshots' && screenshots.length === 0
      ? 'mocks'
      : requestedVisualMode
  if (effectiveVisualMode !== requestedVisualMode) {
    console.warn(`[marketing-video] No screenshots — forcing visualMode=mocks (was ${requestedVisualMode})`)
  }

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
    visualMode: effectiveVisualMode,
    userPrompt: options.userPrompt,
  })

  console.log(`[marketing-video] Script: ${script.scenes.length} scenes, ${script.totalDurationSeconds}s total`)

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
      const durationMs = Math.round(script.totalDurationSeconds * 1000)
      console.log(`[marketing-video] Music: AI-generating (${styleId}), durationMs=${durationMs}`)
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

  const { generateText } = await import('../../shared/ai/gemini.client.js')

  // Detect creative instructions — "plus dynamic", "make it pop", "plus
  // wahou", "rewrite the scenes", etc. — vs surgical ones ("change X
  // to Y", "shorten scene 2"). For creative refines we STRIP the existing
  // mockCode from what we feed the model: anchoring bias is the #1 reason
  // creative refines come back as marginal tweaks. Without the existing
  // TSX in context, Gemini writes from scratch using just the headline +
  // voice-over, exactly like the initial generation.
  const CREATIVE_KEYWORDS = /\b(plus|more|wahou|wow|dynamic|dynamique|animation|animations|moderne|modern|punch|pop|alive|vivant|riche|rich|creative|créatif|fou|dingue|époustouflant|spectaculaire|impressive|jazzy|bold|vibrant|fresh|pop|rewrite|repense|recompose|reimagine)\b/i
  const isCreativeRefine = CREATIVE_KEYWORDS.test(input.instruction)

  // Trim mockCompiledCode always (esbuild output, no signal). Trim
  // mockCode too on creative refines so the model doesn't anchor on
  // the existing animation choreography.
  const editableScript = {
    ...existing.manifest.script,
    scenes: existing.manifest.script.scenes.map((s) => ({
      ...s,
      mockCompiledCode: undefined,
      ...(isCreativeRefine ? { mockCode: undefined } : {}),
    })),
  }
  if (isCreativeRefine) {
    console.log('[marketing-edit] Creative refine detected — stripping existing mockCode to avoid anchoring')
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

## Edit philosophy
The user gives you a **direction**, not a diff. Read it for INTENT.
- **Surgical instructions** ("change X to Y", "shorten scene 2", "swap the icon") → minimal diff. Touch only the asked-for fields, leave the rest verbatim.
- **Creative instructions** ("plus d'animations", "plus wahou", "rends plus dynamic", "more punch", "make it pop", "plus moderne") → REWRITE the scenes' mockCode aggressively. Changing the accent on one element doesn't satisfy "plus wahou" — the user wants visibly different motion, layout, choreography. Don't be timid. Add: parallax, scale-breathe, sequenced reveals, animated charts, cursor flights, gradient pulses, multi-stage transitions.

## Rich animation techniques you can lean into when asked for "more"
- **Layered entries**: cards stagger in with rotateX 8deg → 0deg, opacity 0 → 1, scale 0.92 → 1, with overlapping spring delays (every 6-8 frames).
- **Continuous motion**: subtle floating (Math.sin(f / 30) * 4 px), parallax layers moving at different speeds, scale breathe (1 + Math.sin(f / 40) * 0.015).
- **Cursor-driven moments**: AnimatedCursor at leftPct=N topPct=M with rippleRadius growing 0 → 24 → 0, click ripple on a button, then page transition.
- **Charts that draw in**: progressive Area / Line — slice data by frame so the curve appears point by point. Add a pulsing dot on the latest point.
- **Numbers that count up**: Math.round(interpolate(f, [start, end], [0, finalValue])) with tabular-nums for stability. Layer with a sparkline.
- **Typewriter + caret blink**: charsShown = floor(interpolate(f, [t0, t1], [0, text.length])); caret opacity = (f % 30 < 15) ? 1 : 0.
- **Gradient sweeps**: backgroundPosition animated 0% → 200% over an accent gradient, with backgroundSize: '200% 100%' and a stagger.
- **Layered glows**: a soft radial gradient behind the focal element (NOT on the outer AbsoluteFill — inside a wrapping div) that pulses opacity 0.3 → 0.6 → 0.3.

When the user asks for "plus wahou", combining 2-3 of these per scene is the right ambition. Don't just tweak.

RULES:
- Preserve the overall structure: hook → scenes → cta. Don't add or remove scenes unless the user explicitly asks.
- **Preserve every existing field on each scene/hook/cta in your output.** Even on a creative rewrite where you're regenerating mockCode from scratch, the response MUST include for each scene: \`voiceover\`, \`headline\`, \`subhead\` (if present), \`screenshotIndex\`, \`durationSeconds\`, plus your new \`mockCode\`. Hook + cta keep their \`voiceover\`, \`headline\`, \`durationSeconds\`. Top-level keeps \`totalDurationSeconds\` and \`language\`. Dropping any of these fails the manifest validator and aborts the whole edit.
- Keep totalDurationSeconds === hook.durationSeconds + sum(scenes[].durationSeconds) + cta.durationSeconds.
- Keep word counts realistic at ~2.3 words/sec for voice-over text.
- When editing \`mockCode\`, keep it valid TSX that defines a function named \`MockScene({ branding })\` and follows the Remotion sandbox rules:
  - No \`import\` / \`require\` / \`fetch\` / \`new Function\` / \`eval\`.
  - Only access \`branding.{productName, accentColor, bgColor, textColor, fontFamily}\`.
  - Only invoke \`Remotion.{interpolate, spring, useCurrentFrame, useVideoConfig, AbsoluteFill, Img, Audio, MockFrame, Pill, AccentGlow, AnimatedCursor, Icons, Charts}\`.
  - \`Remotion.Icons.X\` accepts any lucide-react icon name.
  - Outer AbsoluteFill must be transparent — no \`background:\`, no bg-utility classNames. Backdrops go inside cards / MockFrame.
  - No inline \`<svg>\` tags — use \`Remotion.Icons.X\` instead.
  - \`AnimatedCursor\` takes \`leftPct\` + \`topPct\` numbers, NOT a path array.
- If the instruction is unclear or impossible, return the manifest unchanged and explain in the message.
- Voice-over audio + music URLs are NOT yours to change — those are regenerated separately.

Return ONLY valid JSON: { "message": string, "script": <full edited script>, "branding"?: <patch> }.`

  // Try Pro first for better edit reasoning, fall back to Flash on
  // 503 / overload / 429. Pro has visible quality lift on "rewrite the
  // CTA in french while keeping the playful tone" but Flash handles
  // most edits acceptably and is the right pressure-relief when Google
  // returns "model currently experiencing high demand". Without this,
  // a busy Pro cluster blocks every iteration on the editor.
  // Edit uses Flash by default — same reasoning as script gen: the LLM
  // is filling structured slots, not doing creative reasoning. Pro's
  // thinking budget burns invisibly. responseSchema enforces shape
  // server-side so the prompt stays short.
  let result: { text: string }
  try {
    result = await generateText({
      userPrompt: prompt,
      maxTokens: 32_000,
      thinkingBudget: 0,
      temperature: 0.4,
      json: true,
    })
  } catch (err) {
    const message = (err as Error).message ?? ''
    const status = (err as { status?: number }).status
    const isOverload = status === 503 || status === 429
      || /high demand|overload|temporarily unavailable|rate.?limit/i.test(message)
    if (!isOverload) throw err
    console.warn(`[marketing-edit] Flash errored (${status ?? 'no-status'}), retrying`)
    result = await generateText({
      userPrompt: prompt,
      maxTokens: 32_000,
      thinkingBudget: 0,
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

  // Per-scene TSX recompile + rescue. The AI rewrites mockCode for the
  // scenes it touched; we compile each. Same fail-modes / rescue chain
  // as the initial generate path.
  const { compileMockCode } = await import('./mock-code.compiler.js')
  const { repairMockCode } = await import('./marketing-script.generator.js')
  for (const scene of validated.data.script.scenes) {
    const missingMock = !scene.mockCode || scene.mockCode.length === 0
    if (missingMock) continue // legacy/screenshot scene, leave alone
    try {
      const c = await compileMockCode(scene.mockCode!)
      scene.mockCompiledCode = c.compiled
    } catch (err) {
      const firstErr = (err as Error).message
      console.warn(`[marketing-edit] mockCode compile failed for scene "${scene.headline}": ${firstErr} — attempting one rescue`)
      try {
        const rescued = await repairMockCode({
          scene: { headline: scene.headline, voiceover: scene.voiceover, mockCode: scene.mockCode! },
          compileError: firstErr,
        })
        const c = await compileMockCode(rescued)
        scene.mockCode = rescued
        scene.mockCompiledCode = c.compiled
        console.log(`[marketing-edit] Rescued mockCode for scene "${scene.headline}"`)
      } catch (rescueErr) {
        console.warn(`[marketing-edit] Rescue also failed for scene "${scene.headline}": ${(rescueErr as Error).message} — using deterministic fallback`)
        await applyDeterministicFallback(scene, compileMockCode)
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
/**
 * Conversational pre-flight for the marketing-video generation.
 *
 * Instead of asking the user to fill a long form upfront, the panel
 * starts a chat: the AI asks 2-4 targeted questions (audience, key
 * moment, tone) then proposes a structured plan ({ brief, tone,
 * visualMode, music }). The user accepts → the existing /generate
 * endpoint runs with the synthesized brief.
 *
 * Returns one of two shapes:
 *   - { kind: 'question', reply } — keep dialogue going
 *   - { kind: 'plan', reply, plan } — ready to fire generation
 *
 * Mode is decided by the LLM emitting a `ready` flag in the response
 * JSON. We Zod-validate to enforce shape; if the model drifts (e.g.
 * emits `ready: true` with no plan) we treat it as a question and ask
 * the next turn.
 */
export type ConverseTurn = { role: 'user' | 'assistant'; content: string }
export interface ConverseResultQuestion {
  kind: 'question'
  reply: string
}
export interface ConverseResultPlan {
  kind: 'plan'
  reply: string
  plan: {
    userPrompt: string
    tone: import('./marketing-video.types.js').VoiceTone
    visualMode: 'mocks' | 'screenshots'
    withVoiceover: boolean
    musicTrackId: string
    musicVolume: number
  }
}

export async function converseMarketingVideo(
  runId: string,
  history: ConverseTurn[],
): Promise<ConverseResultQuestion | ConverseResultPlan> {
  const run = await findRunById(runId)
  if (!run) {
    // Stale runId — the frontend panel is referencing a run that's been
    // deleted (manual cleanup, SQL drop, etc.). Surface a typed error
    // (code → 'RUN_NOT_FOUND') so the UI can clear its local state and
    // create a fresh stub run on the next chat turn.
    throw new NotFoundError('Run')
  }
  if (!run.docPageId) {
    throw new Error('This run has no linked page. Marketing video needs the page documentation as input.')
  }
  const page = await findPageById(run.docPageId)
  if (!page) throw new Error('Linked page not found')
  const sourceMarkdown = (page.content ?? '').trim()
  const branding = await resolveBranding(page.projectId)

  const { generateText } = await import('../../shared/ai/gemini.client.js')
  const { z } = await import('zod')

  // Discovery brief — the AI plays the role of a brand strategist who
  // wants to understand the angle before pitching. Tight rule: 2-4 turns
  // max, then ship a plan. Don't drag the conversation.
  const systemPrompt = `You are a brand strategist helping the user direct their 45-second marketing video for ${branding.productName}. Your job:

1. Ask 2-4 SHORT targeted questions to understand:
   - WHO is this for? (devs / PMs / founders / end-users / etc.)
   - The ONE moment you want them to remember (a specific stat, demo, transformation, claim)
   - Tone preference (punchy / calm / playful / serious / confident / inspirational / conversational)
   Sometimes 2 questions are enough; sometimes 3-4. Read the prior answers and only ask what's still unclear.

2. Once you have what you need, ship a plan and stop asking. The plan is structured JSON the system uses to generate the video.

Source documentation excerpt (your factual ground truth — never invent features):
${sourceMarkdown.slice(0, 2500)}

Project branding:
- Product: ${branding.productName}
- Accent color: ${branding.accentColor}

## Output format

Return ONLY one valid JSON object per turn — no markdown fences, no preamble. Two possible shapes:

While gathering info:
{
  "ready": false,
  "reply": "Short conversational message + ONE question. Be tight. Use specific examples ('a ratio like 10x?', 'the moment they install in 30s?') over abstract prompts."
}

When you've got enough to commit to a plan:
{
  "ready": true,
  "reply": "1-3 sentence summary of the plan you're proposing, in plain language. End with a soft confirm like 'Sound right?' or 'Want to pivot before I generate?'",
  "plan": {
    "userPrompt": "the synthesized brief — angle + audience + the key moment + any constraints. 2-4 sentences. This is what the script generator reads.",
    "tone": "punchy" | "calm" | "playful" | "serious" | "confident" | "inspirational" | "conversational",
    "visualMode": "mocks" | "screenshots",
    "withVoiceover": true,
    "musicTrackId": "ai-cinematic" | "ai-upbeat" | "ai-lofi" | "ai-ambient" | "ai-synthwave" | "ai-acoustic" | "ai-tech" | "ai-inspirational" | "ai-playful" | "ai-dark" | "ai" | "none",
    "musicVolume": 0.15
  }
}

## Style rules

- One question per turn. Never bundle 3 questions in one message — overwhelms.
- If the user gives you everything in their first message ("I want a 45s video aimed at solo devs, focus on the 1-line API call, confident tone"), skip straight to ready:true with the plan.
- Don't ask about visualMode / music explicitly — infer from the user's vibe (developer-y → "mocks" + tech music; storytelling → mocks + inspirational; product showcase → screenshots if available).
- For visualMode: ALWAYS pick "mocks" UNLESS the user has already produced a screen recording for this page AND explicitly asks to use real screenshots. If you're unsure, "mocks" is correct — the templates produce designed visuals that work without any UI source material. "screenshots" mode requires actual product screenshots and produces blank scenes if none exist.
- For musicTrackId: pick the AI music style that fits the tone (cinematic for inspirational, lofi for conversational, etc.). Avoid 'none' unless the user explicitly asks for silent.
- Keep replies under ~40 words. The chat UI is small.`

  const userPrompt = `Conversation so far:

${history.map((t, i) => `${i === 0 ? '' : '\n'}${t.role.toUpperCase()}: ${t.content}`).join('')}

Your turn — emit the JSON object for the next response.`

  const result = await generateText({
    systemPrompt,
    userPrompt,
    maxTokens: 1_500,
    // Structured JSON output, no reasoning needed → disable thinking.
    thinkingBudget: 0,
    temperature: 0.5,
    json: true,
  })

  // Parse + validate. Defensive about markdown fences if the model adds them.
  let raw = result.text.trim()
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '').trim()
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (err) {
    console.warn(`[marketing-converse] Failed to parse model JSON: ${(err as Error).message}`)
    return { kind: 'question', reply: "Hmm, j'ai eu un hoquet — peux-tu reformuler ?" }
  }

  const QuestionShape = z.object({ ready: z.literal(false), reply: z.string().min(1) })
  const PlanShape = z.object({
    ready: z.literal(true),
    reply: z.string().min(1),
    plan: z.object({
      userPrompt: z.string().min(1).max(2000),
      tone: z.enum(['punchy', 'calm', 'playful', 'serious', 'confident', 'inspirational', 'conversational']),
      visualMode: z.enum(['mocks', 'screenshots']),
      withVoiceover: z.boolean(),
      musicTrackId: z.string().min(1).max(40),
      musicVolume: z.number().min(0).max(1),
    }),
  })

  const asQuestion = QuestionShape.safeParse(parsed)
  if (asQuestion.success) {
    return { kind: 'question', reply: asQuestion.data.reply }
  }
  const asPlan = PlanShape.safeParse(parsed)
  if (asPlan.success) {
    return { kind: 'plan', reply: asPlan.data.reply, plan: asPlan.data.plan }
  }
  // Drift: model emitted something off-shape. Fall back to "treat as
  // question" so the user isn't blocked.
  console.warn('[marketing-converse] Model output drifted, treating as question:', JSON.stringify(parsed).slice(0, 200))
  const reply = (parsed as { reply?: string })?.reply
  return { kind: 'question', reply: reply ?? 'Une question de plus pour clarifier ?' }
}

export async function setMarketingThumbnailForRun(
  runId: string,
  jpegBase64: string,
): Promise<{ thumbnailUrl: string; thumbnailPath: string }> {
  const { findMarketingVideoByRunId, saveMarketingVideo } = await import('./marketing-video.repository.js')
  const existing = await findMarketingVideoByRunId(runId)
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
  const thumbnailPath = `runs/${runId}/marketing-thumbnail.jpg`
  await uploadToStorage('artifacts', thumbnailPath, buffer, 'image/jpeg')
  const thumbnailUrl = `${getPublicUrl('artifacts', thumbnailPath) ?? ''}?v=${Date.now()}`

  await saveMarketingVideo(runId, {
    ...existing,
    manifest: { ...existing.manifest, thumbnailUrl, thumbnailPath },
  })

  console.log(`[marketing-video] Thumbnail uploaded: ${thumbnailUrl} (${buffer.byteLength} bytes)`)
  return { thumbnailUrl, thumbnailPath }
}

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
