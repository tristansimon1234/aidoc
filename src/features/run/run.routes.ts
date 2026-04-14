import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError, AppError } from '../../shared/middleware/error.middleware.js'
import { CreateRunSchema, RunIdParamSchema } from './run.schema.js'
import * as runService from './run.service.js'

export const runRouter = Router()

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
      const body = req.body as { videoPath?: string }
      if (!body.videoPath || typeof body.videoPath !== 'string') {
        throw new ValidationError('videoPath is required')
      }
      const result = await runService.analyzeVideo(params.data.id, body.videoPath)
      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})

// Generate SOP doc
runRouter.post('/:id/generate-doc', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      // Verify run has steps before generating
      const steps = await runService.getRunSteps(params.data.id)
      if (steps.length === 0) {
        throw new AppError('No steps found — the video analysis didn\'t detect any actions. Try re-uploading.', 'NO_STEPS', 400)
      }

      const doc = await runService.generateDoc(params.data.id)
      res.status(200).json(doc)
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
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = req.body as { voiceId?: string; language?: string; tone?: string }

      // Check ElevenLabs is configured before attempting
      const { isElevenLabsConfigured } = await import('../../shared/ai/elevenlabs.client.js')
      if (!isElevenLabsConfigured()) {
        throw new AppError('Voice-over requires ELEVENLABS_API_KEY to be configured', 'ELEVENLABS_NOT_CONFIGURED', 400)
      }

      const { generateVoiceover } = await import('../documentation/voiceover.service.js')

      // Get the generated doc content — this is the quality source
      const run = await runService.getRun(params.data.id)
      if (!run) throw new AppError('Run not found', 'RUN_NOT_FOUND', 404)

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

      // Build time budget — ~2.2 words/sec spoken, but budget at 1.8 to leave room for pauses + tags
      const timeBudgets = timestamps.map((t, i) => {
        const next = timestamps[i + 1] ?? (t + 15)
        return next - t
      })
      const totalVideoTime = (timestamps[timestamps.length - 1] ?? 0) - (timestamps[0] ?? 0) + 15
      const totalMaxWords = Math.floor(totalVideoTime * 1.8)
      const sectionList = timestamps.map((_, i) => {
        const budget = timeBudgets[i]!
        const maxWords = Math.max(4, Math.floor(budget * 1.8))
        return `[SECTION ${i + 1}] (${budget.toFixed(0)}s → HARD LIMIT ${maxWords} words)`
      }).join('\n')

      // Ask Gemini to transform the DOC into a narration script
      // Tone presets — controls voice delivery style
      const TONE_PRESETS: Record<string, { label: string; direction: string; example: string }> = {
        friendly: {
          label: 'Friendly & Casual',
          direction: `Warm, upbeat, conversational. Use contractions, light humor. Keep it SHORT — say it in one sentence when you can.`,
          example: `[SECTION 1]\nHey! [excited] Let's set up your workspace.\n[SECTION 2]\nCreate a new project — this is home base for your docs. [laughs] Easy.`,
        },
        professional: {
          label: 'Professional & Clear',
          direction: `Polished, confident, measured. Clear and articulate, no filler. One precise sentence per idea.`,
          example: `[SECTION 1]\nWelcome. Let's set up your workspace.\n[SECTION 2]\nFirst, create a project. [short pause] Each project groups docs for one product.`,
        },
        energetic: {
          label: 'Energetic & Hyped',
          direction: `High-energy, PUMPED. CAPS for emphasis, short punchy sentences. [excited], [laughs], [happy gasp].`,
          example: `[SECTION 1]\n[excited] Let's GO! Time to set up your workspace.\n[SECTION 2]\nCreate a project — [happy gasp] watch how fast this is!`,
        },
        calm: {
          label: 'Calm & Reassuring',
          direction: `Gentle, patient. Ellipses for breathing room... reassuring phrases. [whispers] for tips.`,
          example: `[SECTION 1]\nHi... welcome. [calm] Let's set up your workspace together.\n[SECTION 2]\nCreate a project... [whispers] it only takes a moment.`,
        },
        playful: {
          label: 'Playful & Fun',
          direction: `Witty, cheeky. Light sarcasm, playful asides. [giggles], [whispers], [sarcastic].`,
          example: `[SECTION 1]\n[laughs] Alright — workspace time. [whispers] Very official.\n[SECTION 2]\nCreate a project. [giggles] Groundbreaking, I know.`,
        },
      }

      const tone = TONE_PRESETS[body.tone ?? 'friendly'] ?? TONE_PRESETS.friendly!

      const { generateText } = await import('../../shared/ai/gemini.client.js')
      const narrationResult = await generateText({
        userPrompt: `You are writing a voice-over narration script for a product tutorial video. The narration plays alongside a screen recording — you guide the viewer through what's about to happen and WHY it matters.

This script will be read by ElevenLabs v3 TTS. Write it as a PERFORMANCE, not an essay.

## Tone: ${tone.label}
${tone.direction}

## ElevenLabs v3 formatting rules (CRITICAL — follow exactly)
The TTS engine interprets formatting as stage directions:

**Punctuation controls delivery:**
- Ellipsis (...) creates a natural pause or trailing off: "So basically... this is where the magic happens."
- Em dash (—) creates a short punchy pause: "Click create — and you're done."
- CAPS emphasize words: "This is REALLY important" → stress on "really"
- Exclamation marks add energy: "That's it!" vs "That's it."
- Questions create natural rising intonation: "Pretty cool, right?"
- Commas and periods = natural breathing rhythm

**Line breaks matter:**
Each line break creates a slight pause. Short lines = snappier delivery:
"Click create.
And just like that — your project is live."

**Audio tags are stage directions** — place them between sentences to shape emotion:
Emotional: [excited], [happy], [calm], [nervous], [frustrated]
Reactions: [laughs], [giggles], [sighs], [gasps], [happy gasp]
Delivery: [whispers], [cheerfully], [playfully], [sarcastic], [deadpan]
Pacing: [short pause], [long pause], [rushed], [drawn out]
Cognitive: [hesitates], [matter-of-fact], [reflective]

**Tag rules:**
- Tags go BETWEEN sentences only: "First sentence. [laughs] Second sentence."
- NEVER mid-sentence: NOT "Click the [pause] button"
- Match tags to tone — don't whisper in an energetic script, don't shout in a calm one
- Combine context + tag for best results: "No way... [happy gasp] it actually worked!" is better than just "[happy gasp] it worked"
- Use 4-6 different tags across the full script for variety

## Documentation source:
${doc.markdownContent}

## Script structure — TIMING IS CRITICAL
${numSteps} sections using [SECTION N] markers.
Total word budget: ~${totalMaxWords} words. The narration MUST fit within the video duration.

${sectionList}

⚠️ WORD LIMITS ARE HARD LIMITS — NOT TARGETS.
Each section's word count includes audio tags. If a section says "HARD LIMIT 15 words", your section MUST be ≤15 words. Going over means the narration will desync from the video — the viewer sees one thing while hearing about something else. This RUINS the experience.

Prefer SHORT, punchy lines over long explanations. 1-2 sentences per section is usually enough. Leave breathing room — silence between sections is FINE and feels natural. It's FAR better to be slightly short than to overshoot.

## Content rules
- GREETING: Section 1 MUST start with a short greeting ("Hey!", "Welcome!", "Hi there!")
- CLOSING: The LAST section (Section ${numSteps}) MUST end with a closing phrase like "Thanks for watching!", "That's it — enjoy!", "See you next time!", "And that's a wrap!". This is NON-NEGOTIABLE — never end abruptly.
- CONCISE: say it in fewer words. "Let's create a project" not "What we're going to do now is create a new project"
- ANTICIPATORY: describe what we're ABOUT to do, not what just happened
- EXPLAIN THE WHY: briefly — say WHY, not just WHAT
- Skip: URLs, code, image references, technical IDs
- Never say: "as you can see", "in this tutorial", "notice how", "in this video"

## Example output for this tone:
${tone.example}

## Output
Start DIRECTLY with [SECTION 1]. No preamble, no commentary.`,
        maxTokens: 8192,
      })

      // Parse [SECTION N] markers — strip any preamble before first [SECTION
      console.log(`[voiceover] Gemini narration raw output (${narrationResult.text.length} chars):\n${narrationResult.text.slice(0, 500)}`)
      const firstSectionIdx = narrationResult.text.indexOf('[SECTION')
      const scriptText = firstSectionIdx >= 0 ? narrationResult.text.slice(firstSectionIdx) : narrationResult.text
      const rawSegments = scriptText.split(/\[SECTION \d+\]\s*\n?/).filter((s) => s.trim())
      console.log(`[voiceover] Parsed ${rawSegments.length} sections from Gemini (expected ${numSteps})`)
      const stepsWithText = timestamps.map((_, i) => {
        let text = rawSegments[i]?.trim() ?? `Section ${i + 1}`
        // Enforce word limit — trim to budget if Gemini went over
        const budget = timeBudgets[i]!
        const maxWords = Math.max(4, Math.floor(budget * 1.8))
        const words = text.split(/\s+/)
        if (words.length > maxWords * 1.3) {
          // Over by 30%+ — truncate to limit, ending at a sentence boundary if possible
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
        const limit = Math.max(4, Math.floor(budget * 1.8))
        console.log(`[voiceover] Step ${s.stepIndex}: ${wordCount}/${limit} words (${budget.toFixed(0)}s) "${s.text.slice(0, 80)}${s.text.length > 80 ? '...' : ''}"`)
      }

      const result = await generateVoiceover(params.data.id, stepsWithText, timestamps, {
        voiceId: body.voiceId,
        language: body.language,
      })

      // Store voiceover info in run summary
      const existingSummary = run.summaryJson ?? {}
      const { updateRunSummary } = await import('./run.repository.js')
      await updateRunSummary(params.data.id, { ...existingSummary, voiceover: result })

      res.status(200).json(result)
    } catch (err) {
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

      // Update summary with new video path
      const { updateRunSummary } = await import('./run.repository.js')
      await updateRunSummary(params.data.id, {
        ...summary,
        videoPath: trimmedPath,
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
