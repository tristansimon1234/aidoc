import { synthesizeSpeech, isElevenLabsConfigured } from '../../shared/ai/elevenlabs.client.js'
import { uploadToStorage, getPublicUrl, downloadFromStorage } from '../../shared/db/storage.repository.js'

/** Cheap heuristic for the authoritative narration language: count French
 *  diacritics + stopwords vs English stopwords. Avoids a Gemini round-trip
 *  and, more importantly, stops the narrator picking up the UI language of
 *  the video when the written doc is in a different language. */
function detectDocLanguage(markdown: string): string {
  if (!markdown || markdown.length < 30) return 'English'
  const text = markdown.toLowerCase()
  const diacritics = (text.match(/[àâäéèêëïîôöùûüÿç]/g) ?? []).length
  const frenchStops = (text.match(/\b(le|la|les|un|une|des|du|est|sont|avec|pour|dans|sur|que|qui|cette|cet|ces|mais|nous|vous|votre|leur|aussi|comme|sera|être|avoir|alors|donc|déjà|ainsi|cliquez|ouvrez|saisissez)\b/g) ?? []).length
  const englishStops = (text.match(/\b(the|is|are|with|for|in|on|that|which|this|but|we|you|your|their|also|will|can|click|open|enter|press|type|have|has|been|here|there|how|what|when|where|next|after|before)\b/g) ?? []).length
  const frenchScore = diacritics * 3 + frenchStops
  const englishScore = englishStops
  return frenchScore > englishScore * 1.3 ? 'French' : 'English'
}

/** Strip half-open ElevenLabs audio tags left behind by Gemini truncation or
 *  our word-limit shortener (e.g. "[happy." or trailing "["). Without this
 *  the TTS either reads the bracket out loud or drops the whole segment. */
function stripBrokenAudioTags(text: string): string {
  let cleaned = text
  cleaned = cleaned.replace(/\s*\[[^\]]*$/g, '').trim()
  cleaned = cleaned.replace(/\[\s*\]/g, '').replace(/(?:^|\s)[\[\]](?=\s|$)/g, '').trim()
  if (cleaned && !/[.!?]$/.test(cleaned)) cleaned = cleaned + '.'
  return cleaned
}

export interface VoiceoverSegment {
  stepIndex: number
  startTime: number
  endTime: number
  text: string
}

/** Silence prepended to the concatenated voice-over so the very first phoneme
 *  of the intro is not clipped. Without it, browser audio-element startup
 *  latency + MP3 decoder priming eat the first ~100-300 ms of speech when the
 *  user clicks play, and users perceive the intro as "cut off". 400 ms is
 *  enough to absorb both effects without feeling like dead air. */
export const INTRO_LEAD_IN_SECONDS = 0.4

export interface VoiceoverResult {
  audioPath: string
  audioUrl: string
  segments: VoiceoverSegment[]
}

/** Options accepted by generateVoiceoverForRun — same contract whether the
 *  caller is the HTTP route (user-triggered from the Video tab) or the MCP
 *  tool (agent-driven). videoDuration comes from the player when available
 *  and lets us cap the last segment precisely; tone picks a preset below. */
export interface GenerateVoiceoverForRunOptions {
  voiceId?: string
  language?: string
  tone?: string
  videoDuration?: number
}

interface TonePreset {
  label: string
  direction: string
  example: string
  wordsPerSecondFactor: number
}

/** Tone preset library. `wordsPerSecondFactor` adjusts the min/max word budget
 *  relative to the 1.5-2.0 wps baseline so Gemini's output lines up with the
 *  actual ElevenLabs playback duration for tones that add non-word time
 *  (ellipses, whispers, emphasis tags). */
const TONE_PRESETS: Record<string, TonePreset> = {
  friendly: {
    label: 'Friendly & Casual',
    direction: `Warm, upbeat, conversational. Use contractions, light humor. Say it in one sentence when you can, but feel free to use a second sentence for context when the slot allows.`,
    example: `[SECTION 1]\nHey! [excited] Let's set up your workspace.\n[SECTION 2]\nCreate a new project — this is home base for your docs. [laughs] Easy.`,
    wordsPerSecondFactor: 1.0,
  },
  professional: {
    label: 'Professional & Clear',
    direction: `Polished, confident, measured. Clear and articulate, no filler. One precise sentence per idea.`,
    example: `[SECTION 1]\nWelcome. Let's set up your workspace.\n[SECTION 2]\nFirst, create a project. [short pause] Each project groups docs for one product.`,
    wordsPerSecondFactor: 1.0,
  },
  energetic: {
    label: 'Energetic & Hyped',
    direction: `High-energy, hyped delivery. Use CAPS for key words (not whole sentences) and energy tags like [excited], [laughs], [happy gasp]. Write COMPLETE, full-length explanations — fill the word budget — the energy comes from the DELIVERY, not from being curt. Don't write fragments or one-word sentences; pumped doesn't mean short.`,
    example: `[SECTION 1]\n[excited] Let's GO! Time to build out your workspace and get everything set up.\n[SECTION 2]\nNow we're creating your first project — [happy gasp] this is where ALL the magic happens, so pay attention to the URL field because that's what drives the AI analysis later.`,
    wordsPerSecondFactor: 1.1,
  },
  calm: {
    label: 'Calm & Reassuring',
    direction: `Gentle, patient delivery. Use ONE ellipsis per section MAX (they add real TTS pause time). Prefer [short pause] tags over \`...\` when you need a beat. Reassuring phrases are great but keep sentences concrete. [whispers] sparingly — once per section at most.`,
    example: `[SECTION 1]\nHi, welcome. [calm] Let's set up your workspace together — it only takes a minute.\n[SECTION 2]\nCreate a project here... [whispers] this is the space where all your docs will live.`,
    wordsPerSecondFactor: 0.7,
  },
  playful: {
    label: 'Playful & Fun',
    direction: `Witty, cheeky. Light sarcasm, playful asides. [giggles], [whispers], [sarcastic].`,
    example: `[SECTION 1]\n[laughs] Alright — workspace time. [whispers] Very official.\n[SECTION 2]\nCreate a project. [giggles] Groundbreaking, I know.`,
    wordsPerSecondFactor: 1.0,
  },
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/**
 * Generate voice-over: one ElevenLabs call per segment,
 * then concatenate with precise silence padding via ffmpeg.
 */
export async function generateVoiceover(
  runId: string,
  steps: { stepIndex: number; text: string }[],
  timestamps: number[],
  options?: { voiceId?: string; language?: string },
): Promise<VoiceoverResult> {
  if (!isElevenLabsConfigured()) {
    throw new Error('ElevenLabs is not configured — set ELEVENLABS_API_KEY')
  }

  if (steps.length === 0) {
    throw new Error('No steps to narrate')
  }

  // Translate if requested
  let stepTexts = steps.map((s) => s.text)
  if (options?.language) {
    const { generateText } = await import('../../shared/ai/gemini.client.js')
    const allText = stepTexts.map((t, i) => `[STEP ${i}]\n${t}`).join('\n\n')
    const translated = await generateText({
      userPrompt: `Translate each step to ${options.language}. Keep the [STEP N] markers. Keep it natural and conversational — this will be read aloud. Output ONLY the translated text.\n\n${allText}`,
      maxTokens: 8192,
    })
    const parts = translated.text.split(/\[STEP \d+\]\n?/)
    if (parts.length > 1) {
      stepTexts = parts.filter((p) => p.trim()).map((p) => p.trim())
    }
  }

  // Generate each segment individually
  const segments: VoiceoverSegment[] = []
  const segmentPaths: { audioPath: string; targetStartTime: number }[] = []

  for (let i = 0; i < steps.length; i++) {
    let text = stepTexts[i] ?? steps[i]!.text
    if (!text || text.length < 3) continue

    const startTime = timestamps[i] ?? 0
    const nextStart = timestamps[i + 1]
    // The intro audio is placed at INTRO_LEAD_IN_SECONDS in the final file (so
    // its first phoneme isn't clipped at playback start), but the next segment
    // still starts at its absolute timestamp. So the intro's actual speaking
    // budget is the slot minus the lead-in — anything longer gets cut by the
    // following segment's targetStartTime.
    const rawSlot = (nextStart ?? (startTime + 15)) - startTime
    const slotDuration = i === 0 ? rawSlot - INTRO_LEAD_IN_SECONDS : rawSlot

    // Synthesize — retry with shorter text if audio overflows the slot
    let buffer = await synthesizeSpeech(text, { voiceId: options?.voiceId })
    let estimatedDuration = Math.max(1, buffer.length / 16000)

    if (estimatedDuration > slotDuration * 1.1 && text.split(/\s+/).length > 6) {
      const words = text.split(/\s+/)
      const targetWords = Math.floor(words.length * (slotDuration / estimatedDuration))
      const shortened = words.slice(0, Math.max(4, targetWords)).join(' ')
      const lastDot = shortened.lastIndexOf('.')
      text = lastDot > shortened.length * 0.4 ? shortened.slice(0, lastDot + 1) : shortened + '.'
      // No hardcoded sign-off injection — the prompt now tells Gemini to
      // write a contextual closing specific to what the user just
      // accomplished. Injecting a generic "Thanks for watching!" on the
      // last segment's overflow replaced a bespoke sign-off with a
      // wallpaper phrase — users hated it.

      console.log(`[voiceover] Segment ${i}: overflow (${estimatedDuration.toFixed(1)}s > ${slotDuration.toFixed(1)}s slot) — retrying with ${text.split(/\s+/).length} words`)

      buffer = await synthesizeSpeech(text, { voiceId: options?.voiceId })
      estimatedDuration = Math.max(1, buffer.length / 16000)
    }

    const segPath = `runs/${runId}/voiceover-seg-${i}.mp3`
    await uploadToStorage('artifacts', segPath, buffer, 'audio/mpeg')

    const endTime = startTime + estimatedDuration
    console.log(`[voiceover] Segment ${i}: ${(buffer.length / 1024).toFixed(0)}KB, ~${estimatedDuration.toFixed(1)}s/${slotDuration.toFixed(0)}s slot, ${startTime.toFixed(1)}→${endTime.toFixed(1)}s`)

    const targetStartTime = i === 0 ? INTRO_LEAD_IN_SECONDS : startTime
    segmentPaths.push({ audioPath: segPath, targetStartTime })
    segments.push({ stepIndex: steps[i]!.stepIndex, startTime, endTime, text })
  }

  // Concatenate with silence padding via video service
  const { isVideoServiceConfigured, concatAudio } = await import('../../shared/video/video.client.js')

  let audioPath: string
  if (isVideoServiceConfigured() && segmentPaths.length > 1) {
    console.log(`[voiceover] Concatenating ${segmentPaths.length} segments...`)
    audioPath = await concatAudio(runId, segmentPaths)
  } else {
    audioPath = segmentPaths[0]?.audioPath ?? `runs/${runId}/voiceover.mp3`
  }

  const audioUrl = `${getPublicUrl('artifacts', audioPath) ?? ''}?v=${Date.now()}`

  console.log(`[voiceover] Done → ${audioUrl}`)

  return { audioPath, audioUrl, segments }
}

/**
 * Full voice-over pipeline for a run: loads the doc + video + step
 * timestamps, massages them into section boundaries, asks Gemini to write
 * a tone-appropriate narration (with video context when available, text-only
 * fallback), enforces word budgets, patches the final farewell, synthesizes
 * via ElevenLabs, persists the result on the run summary, increments usage,
 * and kicks off a background mux so export / MCP get_page serve the muxed
 * MP4 instantly.
 *
 * Single entry point shared by the HTTP route (Video tab) and the MCP
 * generate_voiceover tool — both paths must produce identical audio so an
 * agent and a human get the same result from the same page.
 */
export async function generateVoiceoverForRun(
  runId: string,
  options: GenerateVoiceoverForRunOptions = {},
): Promise<VoiceoverResult> {
  if (!isElevenLabsConfigured()) {
    throw new Error('ElevenLabs is not configured — set ELEVENLABS_API_KEY')
  }

  const { findRunById, updateRunSummary } = await import('../run/run.repository.js')
  const run = await findRunById(runId)
  if (!run) throw new Error(`Run not found: ${runId}`)

  // Prefer the AI-generated doc stored on the run; fall back to the editable
  // page content for hand-written docs. Voice-over should work for both flows.
  const { findDocByRunId } = await import('./documentation.repository.js')
  const doc = await findDocByRunId(runId)
  let sourceMarkdown: string | null = doc?.markdownContent ?? null
  if (!sourceMarkdown && run.docPageId) {
    const { findPageById } = await import('../page/page.repository.js')
    const page = await findPageById(run.docPageId)
    if (page?.content?.trim()) sourceMarkdown = page.content
  }
  if (!sourceMarkdown) {
    throw new Error('This run has no documentation. Generate a doc or write content before the voice-over.')
  }

  const summary = (run.summaryJson ?? {}) as Record<string, unknown>
  const timestamps = Array.isArray(summary.stepTimestamps) ? summary.stepTimestamps as number[] : []
  const numSteps = timestamps.length || 1
  console.log(`[voiceover] Run ${runId}: ${numSteps} raw timestamps, doc length ${sourceMarkdown.length}`)

  // --- Timestamp shaping ---
  // Merge close pairs (< 8 s gap), cap total segment count (~1 per 20 s,
  // 3-10), prepend a 0-timestamp intro with ≥ 6 s budget, drop any final
  // timestamp too close to the video end (< 5 s remaining).
  const mergedTimestamps: number[] = []
  if (timestamps.length > 0) mergedTimestamps.push(timestamps[0]!)
  for (let i = 1; i < timestamps.length; i++) {
    const prev = mergedTimestamps[mergedTimestamps.length - 1]!
    if (timestamps[i]! - prev < 8) continue
    mergedTimestamps.push(timestamps[i]!)
  }
  const videoDur = (timestamps[timestamps.length - 1] ?? 60) - (timestamps[0] ?? 0)
  const maxSegments = Math.max(3, Math.min(10, Math.ceil(videoDur / 20)))
  while (mergedTimestamps.length > maxSegments) {
    let minGap = Infinity
    let minIdx = 1
    for (let i = 1; i < mergedTimestamps.length; i++) {
      const gap = mergedTimestamps[i]! - mergedTimestamps[i - 1]!
      if (gap < minGap) { minGap = gap; minIdx = i }
    }
    mergedTimestamps.splice(minIdx, 1)
  }
  if (mergedTimestamps.length === 0 || mergedTimestamps[0]! !== 0) mergedTimestamps.unshift(0)
  // Minimum SPEAKING budget for the intro (6 s). The lead-in silence is added
  // on top so the actual section-1 boundary is MIN_INTRO_BUDGET + lead-in.
  const MIN_INTRO_BUDGET = 6
  const minSection1Start = MIN_INTRO_BUDGET + INTRO_LEAD_IN_SECONDS
  if (mergedTimestamps.length > 1 && mergedTimestamps[1]! < minSection1Start) {
    mergedTimestamps[1] = minSection1Start
  }

  const estimatedVideoEnd = (options.videoDuration && options.videoDuration > 0)
    ? options.videoDuration
    : (timestamps[timestamps.length - 1] ?? 0) + 5
  while (mergedTimestamps.length > 1) {
    const last = mergedTimestamps[mergedTimestamps.length - 1]!
    if (estimatedVideoEnd - last < 5) mergedTimestamps.pop()
    else break
  }
  console.log(`[voiceover] Merged → ${mergedTimestamps.length} sections, video end ${estimatedVideoEnd.toFixed(1)}s`)

  // --- Script generation via Gemini ---
  const tone = TONE_PRESETS[options.tone ?? 'friendly'] ?? TONE_PRESETS.friendly!
  const wordsFactor = tone.wordsPerSecondFactor
  const narrationLanguage = detectDocLanguage(sourceMarkdown)
  const numStepsMerged = mergedTimestamps.length
  const timeBudgets = mergedTimestamps.map((t, i) => {
    const next = mergedTimestamps[i + 1]
    const raw = next != null ? next - t : Math.max(5, estimatedVideoEnd - t)
    // Intro starts at INTRO_LEAD_IN_SECONDS in the final audio, so its real
    // speaking budget is the slot minus the lead-in. Without this, Gemini
    // writes a full-slot intro and the tail gets clipped by section 2.
    return i === 0 ? raw - INTRO_LEAD_IN_SECONDS : raw
  })
  const totalVideoTime = (mergedTimestamps[mergedTimestamps.length - 1] ?? 0) - (mergedTimestamps[0] ?? 0) + 15
  const totalMaxWords = Math.floor(totalVideoTime * 2 * wordsFactor)
  const sectionList = mergedTimestamps.map((t, i) => {
    const budget = timeBudgets[i]!
    const minWords = Math.max(4, Math.floor(budget * 1.5 * wordsFactor))
    const maxWords = Math.max(6, Math.floor(budget * 2.0 * wordsFactor))
    const nextT = mergedTimestamps[i + 1]
    const timeRange = nextT != null ? `${formatTime(t)}–${formatTime(nextT)}` : `${formatTime(t)}–end`
    return `[SECTION ${i + 1}] (${timeRange}, ${budget.toFixed(0)}s → ${minWords}-${maxWords} words)`
  }).join('\n')

  const videoPath = typeof summary.videoPath === 'string' ? summary.videoPath : null
  let videoBuffer: Buffer | null = null
  let videoMimeType = 'video/mp4'
  if (videoPath) {
    try {
      videoBuffer = await downloadFromStorage('artifacts', videoPath)
      if (videoBuffer) {
        videoMimeType = videoPath.endsWith('.webm') ? 'video/webm' : videoPath.endsWith('.mov') ? 'video/quicktime' : 'video/mp4'
      }
    } catch (err) {
      console.warn(`[voiceover] Could not download video, falling back to text-only: ${(err as Error).message}`)
    }
  }

  const narrationPrompt = buildNarrationPrompt({
    sourceMarkdown,
    narrationLanguage,
    tone,
    numStepsMerged,
    totalMaxWords,
    sectionList,
  })

  let narrationResult: { text: string }
  if (videoBuffer) {
    const { generateNarrationFromVideo } = await import('../../shared/ai/gemini.client.js')
    narrationResult = await generateNarrationFromVideo(
      videoBuffer,
      videoMimeType,
      videoPath?.split('/').pop() ?? 'video.mp4',
      narrationPrompt,
    )
  } else {
    const { generateText } = await import('../../shared/ai/gemini.client.js')
    narrationResult = await generateText({ userPrompt: narrationPrompt, maxTokens: 8192 })
  }

  // Parse [SECTION N] blocks and enforce per-section word budgets.
  const firstSectionIdx = narrationResult.text.indexOf('[SECTION')
  const scriptText = firstSectionIdx >= 0 ? narrationResult.text.slice(firstSectionIdx) : narrationResult.text
  const rawSegments = scriptText.split(/\[SECTION \d+\]\s*\n?/).filter((s) => s.trim())
  const stepsWithText = mergedTimestamps.map((_, i) => {
    let text = rawSegments[i]?.trim() ?? `Section ${i + 1}`
    const budget = timeBudgets[i]!
    const maxWords = Math.max(5, Math.floor(budget * 2.0 * wordsFactor))
    const words = text.split(/\s+/)
    if (words.length > maxWords * 1.2) {
      const truncated = words.slice(0, maxWords).join(' ')
      const lastSentence = truncated.lastIndexOf('.')
      text = lastSentence > truncated.length * 0.5 ? truncated.slice(0, lastSentence + 1) : truncated + '.'
    }
    text = stripBrokenAudioTags(text)
    return { stepIndex: i, text }
  })

  // Farewell safety-net: if the last section doesn't end with an actual
  // goodbye word, a tiny Gemini call appends one grounded in what was just
  // said. Without this, Gemini drops the sign-off ~30 % of the time.
  const lastStep = stepsWithText[stepsWithText.length - 1]
  if (lastStep) {
    const FAREWELL_RE = /(thanks?\s+for\s+(watching|following)|see\s+you|catch\s+you|happy\s+build|have\s+fun|enjoy|cheers|goodbye|bye!?$|take\s+care|merci\s+d['']avoir|à\s+(bient[oô]t|la\s+prochaine|plus)|bon\s+build|bonne\s+(continuation|journ[ée]e)|au\s+revoir|adieu|¡?hasta\s+(la\s+)?pr[oó]xima|gracias\s+por\s+ver|bis\s+bald|viel\s+spa[ßs])/i
    if (!FAREWELL_RE.test(lastStep.text)) {
      try {
        const { generateText } = await import('../../shared/ai/gemini.client.js')
        const farewell = await generateText({
          userPrompt: `This is the final paragraph of a voice-over narration for a product tutorial. It's missing a warm farewell at the end.\n\nWrite ONE short farewell sentence in ${narrationLanguage}, max 15 words. It must feel natural as a spoken outro, include an actual goodbye word (e.g. "Thanks for watching", "See you in the next one", "Merci d'avoir suivi", "À bientôt"), and fit the context of the paragraph below. Do NOT repeat the paragraph. Output ONLY the farewell sentence, nothing else.\n\nParagraph:\n${lastStep.text}`,
          maxTokens: 80,
          temperature: 0.4,
        })
        const cleaned = farewell.text.trim().replace(/^["']|["']$/g, '')
        if (cleaned.length > 0 && cleaned.length < 200 && FAREWELL_RE.test(cleaned)) {
          lastStep.text = lastStep.text.replace(/[.!?]?\s*$/, '. ') + cleaned
        }
      } catch (err) {
        console.warn(`[voiceover] Farewell top-up failed: ${(err as Error).message}`)
      }
    }
  }

  // Synthesize segments + concatenate.
  const timestampsWithEnd = [...mergedTimestamps, estimatedVideoEnd]
  const result = await generateVoiceover(runId, stepsWithText, timestampsWithEnd, {
    voiceId: options.voiceId,
    language: options.language,
  })

  // Persist on the run, invalidate any stale mux, metered usage (best-effort),
  // and fire-and-forget a background mux so exports serve the merged MP4.
  const existingSummary = (run.summaryJson ?? {}) as Record<string, unknown>
  await updateRunSummary(runId, {
    ...existingSummary,
    voiceover: result,
    muxedVideoPath: null,
  })

  void (async () => {
    try {
      const { findTeamIdByRunId, incrementUsage } = await import('../../shared/usage/usage.repository.js')
      const teamId = await findTeamIdByRunId(runId)
      if (teamId) await incrementUsage(teamId, 'voiceover')
    } catch (err) {
      console.warn('[voiceover] usage increment failed:', (err as Error).message)
    }
  })()

  void (async () => {
    try {
      if (!videoPath) return
      const { isVideoServiceConfigured, muxVideoWithAudio } = await import('../../shared/video/video.client.js')
      if (!isVideoServiceConfigured()) return
      const muxedPath = await muxVideoWithAudio(videoPath, result.audioPath, runId)
      const latest = await findRunById(runId)
      const latestSummary = (latest?.summaryJson ?? {}) as Record<string, unknown>
      await updateRunSummary(runId, { ...latestSummary, muxedVideoPath: muxedPath })
    } catch (err) {
      console.warn('[voiceover] post-gen mux failed (lazy fallback still works):', (err as Error).message)
    }
  })()

  return result
}

interface NarrationPromptParams {
  sourceMarkdown: string
  narrationLanguage: string
  tone: TonePreset
  numStepsMerged: number
  totalMaxWords: number
  sectionList: string
}

function buildNarrationPrompt(p: NarrationPromptParams): string {
  return `You are writing a voice-over narration script for this product tutorial video. BLEND two sources:
1. The VIDEO drives TIMING and ACTIONS — watch it to know exactly what happens in each section's slot.
2. The DOCUMENTATION drives CONTENT — it holds the why, the context, the caveats, the terminology, the audience-appropriate wording the author already crafted. Don't just describe pixels; lean on the doc to give the user the understanding the author intended.

Within each section's time slot, synchronize to the video (narrate what's on screen right now, anticipate what's about to happen) BUT flesh out the narration using the documentation's explanations. If the doc mentions a reason, a tip, or a caveat tied to the step you're narrating, include it. If the doc doesn't cover what's on screen, describe the action plainly. Never contradict the doc.

This script will be read by ElevenLabs v3 TTS. Write it as a PERFORMANCE, not an essay.

## Tone: ${p.tone.label}
${p.tone.direction}

## ElevenLabs v3 formatting rules (CRITICAL — follow exactly)
**Punctuation controls delivery:**
- Ellipsis (...) creates a natural pause or trailing off
- Em dash (—) creates a short punchy pause
- CAPS emphasize words: "This is REALLY important"
- Questions create natural rising intonation: "Pretty cool, right?"

**Audio tags are stage directions** — place them between sentences:
Emotional: [excited], [happy], [calm]
Reactions: [laughs], [giggles], [sighs], [happy gasp]
Delivery: [whispers], [cheerfully], [playfully], [sarcastic]
Pacing: [short pause]

Tag rules: tags go BETWEEN sentences only, NEVER mid-sentence. Use 3-5 different tags.

## Documentation — the authoritative content source for the narration

Treat this as the reference for WHAT to say during each section (the explanations, reasons, tips, caveats, and exact terminology the author wrote). The video tells you WHEN each step happens; this tells you HOW to describe it with depth. Prefer the doc's phrasing for feature names, settings labels, and step order — don't rename things Gemini-style.
${p.sourceMarkdown.slice(0, 8000)}

## Script structure — TIMING IS CRITICAL
${p.numStepsMerged} sections using [SECTION N] markers.
Total word budget: ~${p.totalMaxWords} words. The narration MUST fit within the video duration.

${p.sectionList}

⚠️ FILL THE TIME — this is the #1 priority. Each section has a word RANGE (min-max). You MUST write at least the minimum number of words. Silence between sections ruins the experience.
- Count your words for each section. If the minimum says 45 words, write at least 45 words.
- For long sections (15s+): explain the WHY, add context, give tips, describe what's on screen in detail. Use 3-5 sentences.
- For medium sections (8-15s): 2-3 sentences with context.
- For short sections (3-8s): 1-2 punchy sentences.
- Too short = dead silence = BAD. Too long = minor overlap = acceptable.

## Language — STRICT
- The entire narration MUST be written in **${p.narrationLanguage}**. This language has already been determined from the documentation; do not re-detect, do not second-guess, do not change.
- Do not translate to another language, do not switch mid-script, do not mix languages.
- Ignore the language of the video's on-screen UI, the language of the spoken audio in the video, and any tone/examples below — those are just style references. The narration is in ${p.narrationLanguage}, full stop.
- When narrating a UI element whose on-screen label is in a different language than ${p.narrationLanguage}, keep the label verbatim in quotes but describe the action in ${p.narrationLanguage}: e.g. narration in English, button labelled "Paramètres" → "Click 'Paramètres' to open the settings panel."

## Content rules
- BLEND video + doc: the video gives you the TIMING + ACTIONS (what's on screen right now, what's about to happen); the doc gives you the EXPLANATIONS + CONTEXT (the why, the caveats, the exact wording the author used). Use both per section. Don't reduce the narration to a play-by-play of visible pixels — draw on the doc to enrich each moment.
- ANTICIPATORY: narrate what's ABOUT to happen, just before it does
- GREETING: Section 1 starts with a short, product-focused opener (one line, not verbose — get into the content quickly)
- CLOSING: Section ${p.numStepsMerged} ends with TWO parts, in this order, joined into one smooth passage (no list, no line break between them):
  PART A — a one-sentence recap SPECIFIC to what the user just accomplished (mention the feature, the next logical step, or what they can now do). Written in ${p.narrationLanguage}.
  PART B — a real farewell phrase, written in ${p.narrationLanguage}. This is NON-OPTIONAL: the user must hear a goodbye word, not a trailing sentence. Pick something natural that fits the tone — e.g. "Thanks for watching — see you in the next one!", "Have fun building and catch you later!" (when ${p.narrationLanguage} is English) or "Merci d'avoir suivi, à bientôt !", "Bon build, à la prochaine !" (when ${p.narrationLanguage} is French).
  Don't reuse the exact same farewell every time; vary it across videos. But DO include one — "don't be generic" means make PART A specific, not skip PART B.
- Skip: URLs, code, technical IDs
- Never say: "as you can see", "in this tutorial", "notice how"

## Example:
${p.tone.example}

## Output
Start DIRECTLY with [SECTION 1]. No preamble.`
}

