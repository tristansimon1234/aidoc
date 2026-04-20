import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError, AppError } from '../../shared/middleware/error.middleware.js'
import { CreateRunSchema, RunIdParamSchema } from './run.schema.js'
import * as runService from './run.service.js'
import { enforceQuotaOrThrow } from '../../shared/middleware/quota.middleware.js'
import { findTeamIdByRunId } from '../../shared/usage/usage.repository.js'

export const runRouter = Router()

/**
 * Detect the language of a documentation markdown string so the
 * voice-over narration can be pinned to it. Heuristic: count French
 * diacritics + common FR stopwords vs English stopwords. Defaults to
 * English when neither signal dominates — safer than guessing wrong.
 *
 * Not trying to be a general language detector (would need a proper
 * n-gram library); we only need to disambiguate EN vs FR since that's
 * the recurring failure mode (English doc + French-UI screen recording
 * → Gemini picks French). Easy to extend later.
 */
function detectDocLanguage(markdown: string): string {
  if (!markdown || markdown.length < 30) return 'English'
  const text = markdown.toLowerCase()
  const diacritics = (text.match(/[àâäéèêëïîôöùûüÿç]/g) ?? []).length
  const frenchStops = (text.match(/\b(le|la|les|un|une|des|du|est|sont|avec|pour|dans|sur|que|qui|cette|cet|ces|mais|nous|vous|votre|leur|aussi|comme|sera|être|avoir|alors|donc|déjà|ainsi|cliquez|ouvrez|saisissez)\b/g) ?? []).length
  const englishStops = (text.match(/\b(the|is|are|with|for|in|on|that|which|this|but|we|you|your|their|also|will|can|click|open|enter|press|type|have|has|been|here|there|how|what|when|where|next|after|before)\b/g) ?? []).length
  // Each diacritic counts as 3 French points — they're strong signals.
  // Stopwords each count as 1. English defaults when scores are close.
  const frenchScore = diacritics * 3 + frenchStops
  const englishScore = englishStops
  return frenchScore > englishScore * 1.3 ? 'French' : 'English'
}

/** Resolve the team a run belongs to, throws if unknown. Used as the single
 *  quota-enforcement anchor on run-scoped routes. */
async function teamForRun(runId: string): Promise<string> {
  const teamId = await findTeamIdByRunId(runId)
  if (!teamId) throw new AppError('Run has no team context', 'NO_TEAM', 400)
  return teamId
}

runRouter.get('/', (_req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const runs = await runService.listRuns()
      res.status(200).json(runs)
    } catch (err) {
      next(err)
    }
  })()
})

runRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const parsed = CreateRunSchema.safeParse(req.body)
      if (!parsed.success) throw new ValidationError(parsed.error.flatten())
      const run = await runService.createRun(parsed.data)
      res.status(201).json(run)
    } catch (err) {
      next(err)
    }
  })()
})

// SSE stream — live exploration events
runRouter.post('/:id/explore', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      // Exploration is the single most expensive op we run (Claude + Browserbase
      // + Gemini). Refuse hard-cap plans at 100% before spinning up a browser.
      await enforceQuotaOrThrow(await teamForRun(params.data.id))

      const body = req.body as { context?: string }
      const context = typeof body.context === 'string' ? body.context : undefined

      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()

      await runService.exploreWithEvents(
        params.data.id,
        (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`)
        },
        context,
      )

      // Final event
      res.write(`data: ${JSON.stringify({ type: 'close' })}\n\n`)
      res.end()
    } catch (err) {
      // If headers already sent, write error as SSE
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: (err as Error).message })}\n\n`)
        res.end()
      } else {
        next(err)
      }
    }
  })()
})

// Cancel a running exploration
runRouter.post('/:id/cancel', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      await runService.cancelExploration(params.data.id)
      res.status(200).json({ cancelled: true })
    } catch (err) {
      next(err)
    }
  })()
})

// Get a signed upload URL for uploading artifacts directly to Supabase Storage
runRouter.post('/:id/signed-upload-url', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = req.body as { path?: string }
      if (!body.path || typeof body.path !== 'string') {
        throw new ValidationError('path is required')
      }
      const { createSignedUploadUrl } = await import('../../shared/db/storage.repository.js')
      const signedUrl = await createSignedUploadUrl('artifacts', body.path)
      res.status(200).json({ signedUrl, path: body.path })
    } catch (err) {
      next(err)
    }
  })()
})

// Update a step's screenshot path after client-side upload
runRouter.post('/:id/steps/:stepIndex/screenshot', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const stepIndex = Number(req.params.stepIndex)
      if (isNaN(stepIndex)) throw new ValidationError('stepIndex must be a number')
      const body = req.body as { screenshotPath?: string }
      if (!body.screenshotPath || typeof body.screenshotPath !== 'string') {
        throw new ValidationError('screenshotPath is required')
      }
      const { updateStepScreenshot } = await import('./run.repository.js')
      await updateStepScreenshot(params.data.id, stepIndex, body.screenshotPath)
      res.status(200).json({ ok: true })
    } catch (err) {
      next(err)
    }
  })()
})

// Analyze video — Gemini extracts steps from a screen recording
runRouter.post('/:id/analyze-video', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      await enforceQuotaOrThrow(await teamForRun(params.data.id))

      const body = req.body as { videoPath?: string; generateDoc?: boolean }
      if (!body.videoPath || typeof body.videoPath !== 'string') {
        throw new ValidationError('videoPath is required')
      }

      // If generateDoc flag is set, create a DB job and run the full pipeline.
      // The HTTP connection stays open — fetch survives client-side navigation.
      // The job row in DB survives browser refresh.
      if (body.generateDoc) {
        const run = await runService.getRun(params.data.id)
        if (!run.docPageId) throw new AppError('Run has no linked page', 'NO_PAGE', 400)
        const { findPageById } = await import('../page/page.repository.js')
        const page = await findPageById(run.docPageId)
        if (!page) throw new AppError('Linked page not found', 'PAGE_NOT_FOUND', 404)
        const { createJob, updateJobStatus } = await import('./job.repository.js')

        let job: { id: string }
        try {
          job = await createJob({
            runId: params.data.id,
            pageId: run.docPageId,
            projectId: page.projectId,
            type: 'doc-gen',
          })
        } catch (dupErr) {
          // Unique constraint violation = job already running for this page
          if ((dupErr as Error).message?.includes('duplicate') || (dupErr as Error).message?.includes('unique')) {
            throw new AppError('A doc generation is already running for this page', 'JOB_ALREADY_RUNNING', 409)
          }
          throw dupErr
        }

        try {
          await runService.analyzeVideo(params.data.id, body.videoPath)
          await runService.generateDoc(params.data.id, (req as Request & { userId?: string }).userId ?? null)
          if (run.docPageId) {
            const { updatePage } = await import('../page/page.repository.js')
            await updatePage(run.docPageId, { status: 'published' })
          }
          await updateJobStatus(job.id, 'completed')
        } catch (pipelineErr) {
          await updateJobStatus(job.id, 'failed', (pipelineErr as Error).message).catch(() => {})
          throw pipelineErr
        }
        res.status(200).json({ jobId: job.id })
        return
      }

      const result = await runService.analyzeVideo(params.data.id, body.videoPath)
      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})

// Generate SOP doc — responds immediately, generates in background.
// Client tracks progress via Supabase Realtime on runs.status.
runRouter.post('/:id/generate-doc', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      // Refuse hard-cap plans (Free / Startup) at 100% budget — doc gen is the
      // most expensive op we run.
      await enforceQuotaOrThrow(await teamForRun(params.data.id))

      // Verify run has steps before generating
      const steps = await runService.getRunSteps(params.data.id)
      if (steps.length === 0) {
        throw new AppError('No steps found — the video analysis didn\'t detect any actions. Try re-uploading.', 'NO_STEPS', 400)
      }

      const triggeredBy = (req as Request & { userId?: string }).userId ?? null
      const async = req.query.async === '1'
      if (async) {
        // Non-blocking: respond immediately, generate in background
        res.status(202).json({ runId: params.data.id, status: 'running' })
        void runService.generateDoc(params.data.id, triggeredBy).catch((err) =>
          console.error(`[generate-doc] Background generation failed for ${params.data.id}:`, err),
        )
      } else {
        // Legacy blocking mode (for backwards compat)
        const doc = await runService.generateDoc(params.data.id, triggeredBy)
        res.status(200).json(doc)
      }
    } catch (err) {
      next(err)
    }
  })()
})

// Get available ElevenLabs voices
runRouter.get('/voices', (_req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const { isElevenLabsConfigured, getAvailableVoices } = await import('../../shared/ai/elevenlabs.client.js')
      if (!isElevenLabsConfigured()) {
        res.json({ voices: [] })
        return
      }
      const voices = await getAvailableVoices()
      console.log(`[voices] Returning ${voices.length} voices`)
      res.json({ voices })
    } catch (err) {
      console.error('[voices] Error:', err)
      next(err)
    }
  })()
})

// Generate voice-over narration from documentation
runRouter.post('/:id/generate-voiceover', (req: Request, res: Response, next: NextFunction) => {
  let voiceoverJobId: string | null = null
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      await enforceQuotaOrThrow(await teamForRun(params.data.id))

      const body = req.body as { voiceId?: string; language?: string; tone?: string; videoDuration?: number }

      // Check ElevenLabs is configured before attempting
      const { isElevenLabsConfigured } = await import('../../shared/ai/elevenlabs.client.js')
      if (!isElevenLabsConfigured()) {
        throw new AppError('Voice-over requires ELEVENLABS_API_KEY to be configured', 'ELEVENLABS_NOT_CONFIGURED', 400)
      }

      const { generateVoiceover } = await import('../documentation/voiceover.service.js')

      // Get the generated doc content — this is the quality source
      const run = await runService.getRun(params.data.id)
      if (!run) throw new AppError('Run not found', 'RUN_NOT_FOUND', 404)

      // Create a DB job so tracker survives navigation + refresh
      if (run.docPageId) {
        try {
          const { findPageById } = await import('../page/page.repository.js')
          const page = await findPageById(run.docPageId)
          if (page) {
            const { createJob } = await import('./job.repository.js')
            const job = await createJob({ runId: params.data.id, pageId: run.docPageId, projectId: page.projectId, type: 'voiceover' })
            voiceoverJobId = job.id
          }
        } catch { /* duplicate job or missing page — continue without tracking */ }
      }

      const { findDocByRunId } = await import('../documentation/documentation.repository.js')
      const doc = await findDocByRunId(params.data.id)
      if (!doc?.markdownContent) {
        throw new AppError('Generate documentation first before creating voice-over', 'DOC_NOT_FOUND', 404)
      }

      // Get timestamps from run summary
      const summary = run.summaryJson as Record<string, unknown> | null
      const timestamps = (summary?.stepTimestamps as number[]) ?? []
      const numSteps = timestamps.length || 1

      console.log(`[voiceover] Run ${params.data.id}: ${numSteps} steps, timestamps: [${timestamps.map(t => t.toFixed(1)).join(', ')}]`)
      console.log(`[voiceover] Doc content length: ${doc.markdownContent.length} chars`)

      // Build time budget — merge short sections, add intro/outro
      const mergedTimestamps: number[] = []

      // Always keep the first timestamp
      if (timestamps.length > 0) {
        mergedTimestamps.push(timestamps[0]!)
      }
      // Merge subsequent timestamps that are too close (< 8s gap)
      for (let i = 1; i < timestamps.length; i++) {
        const prev = mergedTimestamps[mergedTimestamps.length - 1]!
        const gap = timestamps[i]! - prev
        if (gap < 8) continue
        mergedTimestamps.push(timestamps[i]!)
      }

      // Cap segments: ~1 per 20s of video, min 3, max 10
      const videoDur = (timestamps[timestamps.length - 1] ?? 60) - (timestamps[0] ?? 0)
      const maxSegments = Math.max(3, Math.min(10, Math.ceil(videoDur / 20)))
      while (mergedTimestamps.length > maxSegments) {
        // Find the smallest gap between consecutive timestamps
        let minGap = Infinity
        let minIdx = 1
        for (let i = 1; i < mergedTimestamps.length; i++) {
          const gap = mergedTimestamps[i]! - mergedTimestamps[i - 1]!
          if (gap < minGap) { minGap = gap; minIdx = i }
        }
        mergedTimestamps.splice(minIdx, 1)
      }

      // Intro: if first action starts late (> 3s), prepend a timestamp at 0 for greeting
      if (mergedTimestamps.length > 0 && mergedTimestamps[0]! > 3) {
        mergedTimestamps.unshift(0)
      }

      // Drop last timestamp if too close to video end (< 5s remaining = not enough for a segment)
      // Use actual video duration if provided by frontend, otherwise estimate
      const estimatedVideoEnd = (body.videoDuration && body.videoDuration > 0)
        ? body.videoDuration
        : (timestamps[timestamps.length - 1] ?? 0) + 5
      console.log(`[voiceover] Video end: ${estimatedVideoEnd.toFixed(1)}s${body.videoDuration ? ' (from player)' : ' (estimated)'}`)
      while (mergedTimestamps.length > 1) {
        const last = mergedTimestamps[mergedTimestamps.length - 1]!
        if (estimatedVideoEnd - last < 5) {
          mergedTimestamps.pop()
        } else {
          break
        }
      }

      console.log(`[voiceover] Merged ${timestamps.length} timestamps → ${mergedTimestamps.length} sections: [${mergedTimestamps.map(t => t.toFixed(1)).join(', ')}]`)

      // Ask Gemini to transform the DOC into a narration script.
      // Tone presets — controls voice delivery style.
      // wordsPerSecondFactor adjusts the min/max words budget relative to
      // the 1.5-2.0 words/sec baseline so Gemini's output lines up with
      // ElevenLabs playback duration for tones that add non-word timing
      // (ellipses, whispers, emphasis tags).
      //   < 1.0 = script gets fewer words because TTS is slower for this
      //           tone (pauses, whispers)
      //   > 1.0 = script gets more words because TTS runs at normal pace
      //           with short punchy sentences (energetic tone writes more
      //           individual sentences than long ones would)
      const TONE_PRESETS: Record<string, { label: string; direction: string; example: string; wordsPerSecondFactor: number }> = {
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

      const tone = TONE_PRESETS[body.tone ?? 'friendly'] ?? TONE_PRESETS.friendly!
      const wordsFactor = tone.wordsPerSecondFactor

      // Detect the documentation language so we can pin it into the
      // prompt as an explicit constant. Gemini was otherwise picking
      // up the French UI / audio from the video when the user recorded
      // a French-UI app — even though the doc was English. Heuristic:
      // count French diacritics + stopwords vs English stopwords. No
      // extra Gemini call needed. Defaults to English when neither
      // signal is clearly dominant.
      const narrationLanguage = detectDocLanguage(doc.markdownContent ?? '')
      console.log(`[voiceover] Detected doc language: ${narrationLanguage}`)

      const numStepsMerged = mergedTimestamps.length
      const timeBudgets = mergedTimestamps.map((t, i) => {
        const next = mergedTimestamps[i + 1]
        if (next != null) return next - t
        // Last segment: cap at video end, min 5s
        return Math.max(5, estimatedVideoEnd - t)
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

      function formatTime(s: number): string {
        const m = Math.floor(s / 60)
        const sec = Math.floor(s % 60)
        return `${m}:${sec.toString().padStart(2, '0')}`
      }

      // Download video for Gemini to watch while generating narration
      const videoPath = summary?.videoPath as string | undefined
      const { downloadFromStorage } = await import('../../shared/db/storage.repository.js')
      let videoBuffer: Buffer | null = null
      let videoMimeType = 'video/mp4'
      if (videoPath) {
        try {
          videoBuffer = await downloadFromStorage('artifacts', videoPath)
          if (videoBuffer) {
            videoMimeType = videoPath.endsWith('.webm') ? 'video/webm' : videoPath.endsWith('.mov') ? 'video/quicktime' : 'video/mp4'
            console.log(`[voiceover] Video downloaded for narration: ${videoPath} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`)
          }
        } catch (err) {
          console.warn(`[voiceover] Could not download video, falling back to text-only: ${(err as Error).message}`)
        }
      }

      // Generate narration — with video if available, text-only as fallback
      const narrationPrompt = `You are writing a voice-over narration script for this product tutorial video. WATCH THE VIDEO CAREFULLY — your narration must describe exactly what's happening on screen at each moment.

This script will be read by ElevenLabs v3 TTS. Write it as a PERFORMANCE, not an essay.

## Tone: ${tone.label}
${tone.direction}

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

## Documentation context (for terminology and feature names):
${doc.markdownContent.slice(0, 3000)}

## Script structure — TIMING IS CRITICAL
${numStepsMerged} sections using [SECTION N] markers.
Total word budget: ~${totalMaxWords} words. The narration MUST fit within the video duration.

${sectionList}

⚠️ FILL THE TIME — this is the #1 priority. Each section has a word RANGE (min-max). You MUST write at least the minimum number of words. Silence between sections ruins the experience.
- Count your words for each section. If the minimum says 45 words, write at least 45 words.
- For long sections (15s+): explain the WHY, add context, give tips, describe what's on screen in detail. Use 3-5 sentences.
- For medium sections (8-15s): 2-3 sentences with context.
- For short sections (3-8s): 1-2 punchy sentences.
- Too short = dead silence = BAD. Too long = minor overlap = acceptable.

## Language — STRICT
- The entire narration MUST be written in **${narrationLanguage}**. This language has already been determined from the documentation; do not re-detect, do not second-guess, do not change.
- Do not translate to another language, do not switch mid-script, do not mix languages.
- Ignore the language of the video's on-screen UI, the language of the spoken audio in the video, and any tone/examples below — those are just style references. The narration is in ${narrationLanguage}, full stop.
- When narrating a UI element whose on-screen label is in a different language than ${narrationLanguage}, keep the label verbatim in quotes but describe the action in ${narrationLanguage}: e.g. narration in English, button labelled "Paramètres" → "Click 'Paramètres' to open the settings panel."

## Content rules
- WATCH THE VIDEO: describe what you SEE happening, not what the doc says
- ANTICIPATORY: narrate what's ABOUT to happen, just before it does
- GREETING: Section 1 starts with a short, product-focused opener (one line, not verbose — get into the content quickly)
- CLOSING: Section ${numStepsMerged} ends with TWO parts, in this order, joined into one smooth passage (no list, no line break between them):
  PART A — a one-sentence recap SPECIFIC to what the user just accomplished (mention the feature, the next logical step, or what they can now do). Written in ${narrationLanguage}.
  PART B — a real farewell phrase, written in ${narrationLanguage}. This is NON-OPTIONAL: the user must hear a goodbye word, not a trailing sentence. Pick something natural that fits the tone — e.g. \"Thanks for watching — see you in the next one!\", \"Have fun building and catch you later!\" (when ${narrationLanguage} is English) or \"Merci d'avoir suivi, à bientôt !\", \"Bon build, à la prochaine !\" (when ${narrationLanguage} is French).
  Don't reuse the exact same farewell every time; vary it across videos. But DO include one — \"don't be generic\" means make PART A specific, not skip PART B.
- Skip: URLs, code, technical IDs
- Never say: "as you can see", "in this tutorial", "notice how"

## Example:
${tone.example}

## Output
Start DIRECTLY with [SECTION 1]. No preamble.`

      let narrationResult: { text: string }

      if (videoBuffer) {
        const { generateNarrationFromVideo } = await import('../../shared/ai/gemini.client.js')
        narrationResult = await generateNarrationFromVideo(
          videoBuffer,
          videoMimeType,
          videoPath?.split('/').pop() ?? 'video.mp4',
          narrationPrompt,
        )
        console.log(`[voiceover] Narration generated from VIDEO (${narrationResult.text.length} chars)`)
      } else {
        const { generateText } = await import('../../shared/ai/gemini.client.js')
        narrationResult = await generateText({ userPrompt: narrationPrompt, maxTokens: 8192 })
        console.log(`[voiceover] Narration generated from TEXT-ONLY (${narrationResult.text.length} chars)`)
      }

      // Parse [SECTION N] markers — strip any preamble before first [SECTION
      console.log(`[voiceover] Gemini narration raw output (${narrationResult.text.length} chars):\n${narrationResult.text.slice(0, 500)}`)
      const firstSectionIdx = narrationResult.text.indexOf('[SECTION')
      const scriptText = firstSectionIdx >= 0 ? narrationResult.text.slice(firstSectionIdx) : narrationResult.text
      const rawSegments = scriptText.split(/\[SECTION \d+\]\s*\n?/).filter((s) => s.trim())
      console.log(`[voiceover] Parsed ${rawSegments.length} sections from Gemini (expected ${numStepsMerged})`)
      const stepsWithText = mergedTimestamps.map((_, i) => {
        let text = rawSegments[i]?.trim() ?? `Section ${i + 1}`
        // Enforce word limit — trim to budget if Gemini went way over
        const budget = timeBudgets[i]!
        const maxWords = Math.max(5, Math.floor(budget * 2.0 * wordsFactor))
        const words = text.split(/\s+/)
        if (words.length > maxWords * 1.2) {
          // Over by 20%+ — truncate to limit, ending at a sentence boundary if possible
          const truncated = words.slice(0, maxWords)
          const joined = truncated.join(' ')
          const lastSentence = joined.lastIndexOf('.')
          text = lastSentence > joined.length * 0.5 ? joined.slice(0, lastSentence + 1) : joined + '.'
          console.log(`[voiceover] Step ${i}: TRIMMED from ${words.length} to ~${maxWords} words (budget: ${budget.toFixed(0)}s)`)
        }
        return { stepIndex: i, text }
      })
      for (const s of stepsWithText) {
        const wordCount = s.text.split(/\s+/).length
        const budget = timeBudgets[s.stepIndex]!
        const limit = Math.max(5, Math.floor(budget * 2.0 * wordsFactor))
        console.log(`[voiceover] Step ${s.stepIndex}: ${wordCount}/${limit} words (${budget.toFixed(0)}s) "${s.text.slice(0, 80)}${s.text.length > 80 ? '...' : ''}"`)
      }

      // Pass timestamps + video end sentinel so the service knows the last segment's limit
      const timestampsWithEnd = [...mergedTimestamps, estimatedVideoEnd]

      const result = await generateVoiceover(params.data.id, stepsWithText, timestampsWithEnd, {
        voiceId: body.voiceId,
        language: body.language,
      })

      // Metered: bump monthly voiceover counter for the project owner
      try {
        const { findTeamIdByRunId, incrementUsage } = await import('../../shared/usage/usage.repository.js')
        const teamId = await findTeamIdByRunId(params.data.id)
        if (teamId) await incrementUsage(teamId, 'voiceover')
      } catch (err) {
        console.warn('[usage] increment voiceover failed:', (err as Error).message)
      }

      // Store voiceover info in run summary
      const existingSummary = run.summaryJson ?? {}
      const { updateRunSummary } = await import('./run.repository.js')
      await updateRunSummary(params.data.id, { ...existingSummary, voiceover: result })

      // Mark job completed
      if (voiceoverJobId) {
        const { updateJobStatus } = await import('./job.repository.js')
        await updateJobStatus(voiceoverJobId, 'completed').catch(() => {})
      }

      res.status(200).json(result)
    } catch (err) {
      if (voiceoverJobId) {
        const { updateJobStatus } = await import('./job.repository.js')
        await updateJobStatus(voiceoverJobId, 'failed', (err as Error).message).catch(() => {})
      }
      next(err)
    }
  })()
})

// Regenerate a single voiceover segment
runRouter.post('/:id/regenerate-segment', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      await enforceQuotaOrThrow(await teamForRun(params.data.id))

      const body = req.body as { stepIndex: number; text?: string; voiceId?: string }
      if (body.stepIndex == null) throw new ValidationError('stepIndex is required')

      const { isElevenLabsConfigured } = await import('../../shared/ai/elevenlabs.client.js')
      if (!isElevenLabsConfigured()) {
        throw new AppError('ELEVENLABS_API_KEY required', 'ELEVENLABS_NOT_CONFIGURED', 400)
      }

      const { synthesizeSpeech } = await import('../../shared/ai/elevenlabs.client.js')
      const { uploadToStorage, getPublicUrl } = await import('../../shared/db/storage.repository.js')

      // Get existing voiceover data
      const run = await runService.getRun(params.data.id)
      if (!run) throw new AppError('Run not found', 'RUN_NOT_FOUND', 404)
      const summary = run.summaryJson as Record<string, unknown> | null
      const voiceover = summary?.voiceover as { segments?: Array<Record<string, unknown>> } | undefined
      if (!voiceover?.segments) throw new AppError('No voiceover to edit', 'NO_VOICEOVER', 404)

      // If custom text provided, use it. Otherwise use existing text.
      const existingSeg = voiceover.segments.find((s) => (s.stepIndex as number) === body.stepIndex)
      const text = body.text ?? (existingSeg?.text as string) ?? `Step ${body.stepIndex + 1}`

      // Synthesize new segment audio — use same naming as generateVoiceover
      const buffer = await synthesizeSpeech(text, { voiceId: body.voiceId })
      const segPath = `runs/${params.data.id}/voiceover-seg-${body.stepIndex}.mp3`
      await uploadToStorage('artifacts', segPath, buffer, 'audio/mpeg')

      // Update the segment in the summary
      const updatedSegments = voiceover.segments.map((s) =>
        (s.stepIndex as number) === body.stepIndex
          ? { ...s, audioPath: segPath, text }
          : s,
      )

      // Re-concat ALL segments to rebuild voiceover.mp3
      const { isVideoServiceConfigured, concatAudio } = await import('../../shared/video/video.client.js')
      let mainAudioUrl = ''
      let mainAudioPath = ''

      if (isVideoServiceConfigured()) {
        const concatSegments = updatedSegments
          .sort((a, b) => (a.stepIndex as number) - (b.stepIndex as number))
          .map((s) => ({
            audioPath: (s.audioPath as string) ?? `runs/${params.data.id}/voiceover-seg-${s.stepIndex as number}.mp3`,
            targetStartTime: Math.max(0, (s.startTime as number) - 1.5),
          }))
        mainAudioPath = await concatAudio(params.data.id, concatSegments)
        mainAudioUrl = `${getPublicUrl('artifacts', mainAudioPath) ?? ''}?v=${Date.now()}`
      }

      const { updateRunSummary } = await import('./run.repository.js')
      await updateRunSummary(params.data.id, {
        ...summary,
        voiceover: {
          ...voiceover,
          segments: updatedSegments,
          ...(mainAudioPath ? { audioPath: mainAudioPath, audioUrl: mainAudioUrl } : {}),
        },
      })

      res.status(200).json({ stepIndex: body.stepIndex, audioUrl: mainAudioUrl, text })
    } catch (err) {
      next(err)
    }
  })()
})

// Update voiceover segment timing (drag to reposition)
runRouter.put('/:id/voiceover-segments', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = req.body as { segments: Array<{ stepIndex: number; startTime: number; endTime: number }> }
      if (!Array.isArray(body.segments)) throw new ValidationError('segments array required')

      const run = await runService.getRun(params.data.id)
      if (!run) throw new AppError('Run not found', 'RUN_NOT_FOUND', 404)
      const summary = run.summaryJson as Record<string, unknown> | null
      const voiceover = summary?.voiceover as { segments?: Array<Record<string, unknown>> } | undefined
      if (!voiceover?.segments) throw new AppError('No voiceover to edit', 'NO_VOICEOVER', 404)

      // Merge timing updates into existing segments
      const updatedSegments = voiceover.segments.map((s) => {
        const update = body.segments.find((u) => u.stepIndex === (s.stepIndex as number))
        return update ? { ...s, startTime: update.startTime, endTime: update.endTime } : s
      })

      const { updateRunSummary } = await import('./run.repository.js')
      await updateRunSummary(params.data.id, {
        ...summary,
        voiceover: { ...voiceover, segments: updatedSegments },
      })

      res.status(200).json({ segments: updatedSegments })
    } catch (err) {
      next(err)
    }
  })()
})

// Trim/cut video to a time range
runRouter.post('/:id/trim-video', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = req.body as { startTime: number; endTime: number }
      if (body.startTime == null || body.endTime == null) throw new ValidationError('startTime and endTime required')
      if (body.startTime >= body.endTime) throw new ValidationError('startTime must be before endTime')

      const run = await runService.getRun(params.data.id)
      if (!run) throw new AppError('Run not found', 'RUN_NOT_FOUND', 404)

      const summary = run.summaryJson as Record<string, unknown> | null
      const videoPath = summary?.videoPath as string | undefined
      if (!videoPath) throw new AppError('No video found', 'NO_VIDEO', 404)

      // Trim via video microservice
      const { isVideoServiceConfigured, trimVideo } = await import('../../shared/video/video.client.js')
      if (!isVideoServiceConfigured()) {
        throw new AppError('Video service not configured — set VIDEO_SERVICE_URL', 'VIDEO_SERVICE_NOT_CONFIGURED', 400)
      }

      const trimmedPath = await trimVideo(videoPath, params.data.id, body.startTime, body.endTime)

      // Update summary with new video path + adjust timestamps for trimmed range
      const { updateRunSummary } = await import('./run.repository.js')
      const oldTimestamps = (summary?.stepTimestamps as number[]) ?? []
      const trimmedDuration = body.endTime - body.startTime
      const adjustedTimestamps = oldTimestamps
        .map((t) => t - body.startTime)
        .filter((t) => t >= 0 && t <= trimmedDuration)

      await updateRunSummary(params.data.id, {
        ...summary,
        videoPath: trimmedPath,
        stepTimestamps: adjustedTimestamps,
        trimApplied: { startTime: body.startTime, endTime: body.endTime },
      })

      const { getPublicUrl } = await import('../../shared/db/storage.repository.js')
      const videoUrl = getPublicUrl('artifacts', trimmedPath) ?? ''
      res.status(200).json({ videoPath: trimmedPath, videoUrl })
    } catch (err) {
      next(err)
    }
  })()
})

// Analyze Try Doc — compare exploration results against documentation
runRouter.post('/:id/analyze-try', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      await enforceQuotaOrThrow(await teamForRun(params.data.id))

      const body = req.body as { pageContent: string; pageTitle: string; pageId: string }
      if (!body.pageContent) throw new ValidationError('pageContent is required')
      const report = await runService.analyzeTryDoc(params.data.id, body.pageContent, body.pageTitle, body.pageId)
      res.status(200).json(report)
    } catch (err) {
      next(err)
    }
  })()
})

runRouter.get('/:id', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const run = await runService.getRun(params.data.id)
      res.status(200).json(run)
    } catch (err) {
      next(err)
    }
  })()
})

runRouter.get('/:id/steps', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const steps = await runService.getRunSteps(params.data.id)
      res.status(200).json(steps)
    } catch (err) {
      next(err)
    }
  })()
})

runRouter.get('/:id/questions', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const questions = await runService.getQuestions(params.data.id)
      res.status(200).json(questions)
    } catch (err) {
      next(err)
    }
  })()
})
