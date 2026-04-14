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
      const body = req.body as { voiceId?: string; language?: string }

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

      // Build time budget — very conservative: 1.5 words/sec to leave room for pauses
      const timeBudgets = timestamps.map((t, i) => {
        const next = timestamps[i + 1] ?? (t + 20)
        return next - t
      })
      const totalVideoTime = (timestamps[timestamps.length - 1] ?? 0) - (timestamps[0] ?? 0) + 20
      const totalMaxWords = Math.floor(totalVideoTime * 1.5)
      const sectionList = timestamps.map((_, i) => {
        const budget = timeBudgets[i]!
        const maxWords = Math.max(3, Math.floor(budget * 1.5))
        return `[SECTION ${i + 1}] (${budget.toFixed(0)}s → max ${maxWords} words)`
      }).join('\n')

      // Ask Gemini to transform the DOC into a narration script
      const { generateText } = await import('../../shared/ai/gemini.client.js')
      const narrationResult = await generateText({
        userPrompt: `You are recording voice-over narration for a product tutorial video. Your narration plays slightly before each action on screen — you guide the viewer through what's about to happen and WHY it matters.

## Your approach
You're not just listing clicks. You EXPLAIN the purpose behind each step — why this field matters, what it enables, what the user will get out of it. Think of the best SaaS product tours: they make you understand the value, not just the mechanics.

BAD: "Click 'New Project'." (just a click, no context)
GOOD: "Let's create your first project [short pause] this is where all your docs will live."
GOOD: "Add your app's URL here — the AI uses this to understand your product and generate smarter docs."
GOOD: "Now hit 'Generate' [pause] this is where the magic happens. The AI will watch your recording and write the documentation for you."

## Documentation source:
${doc.markdownContent}

## Script structure
${numSteps} sections using [SECTION N] markers.
Word budget: ~${totalMaxWords} words total. Each section: 1-2 sentences.

${sectionList}

## Content rules
- ANTICIPATORY: describe what we're ABOUT to do, not what just happened
- EXPLAIN THE WHY: don't just say "click X" — say why we're clicking X and what it does
- Add VALUE: mention what features enable, what problems they solve, what the user gains
- NATURAL: contractions (let's, you'll, here's), conversational ("so basically", "the cool thing is")
- Skip: URLs, code, image references, technical IDs
- Never say: "as you can see", "in this tutorial", "notice how"

## Audio expression tags
Place tags BETWEEN sentences only — NEVER in the middle of a sentence. They add rhythm and emotion.

Available tags:
  [laughs] — light friendly warmth after something fun or easy
  [excited] — genuine enthusiasm when revealing a cool feature
  [whispers] — sharing a secret or pro tip
  [sighs] — satisfaction after completing a milestone
  [pause] — beat between two sentences (use sparingly — max 2 in entire script)

CRITICAL RULES for tags:
- Place tags ONLY between complete sentences: "First sentence. [laughs] Second sentence."
- NEVER inside a sentence: NOT "Click the [pause] button" — this sounds broken
- Use at least 3 DIFFERENT tags across the script
- [laughs], [excited], [whispers] are the PRIORITY tags — they add personality
- [pause] is BORING — use it max 2 times in the whole script, prefer the emotional tags instead

## Output
Start DIRECTLY with [SECTION 1]. No preamble.

[SECTION 1]
Hey! So we're gonna set up your workspace — this is where all your documentation lives, organized by project.
[SECTION 2]
Let's create a new project. Think of it as a home for everything related to one product.
[SECTION 3]
Give it a name — this shows up in your sidebar and in the published docs your users will see.
[SECTION 4]
Now add your app's URL. The AI actually uses this to crawl and understand your product better. [whispers] Pretty smart right?
[SECTION 5]
Describe who this is for. This is what makes the generated docs feel personalized instead of generic. [excited] It really works!
[SECTION 6]
Alright hit create and just like that, your project is ready with a default Getting Started page! [laughs] Told you it was quick.`,
        maxTokens: 8192,
      })

      // Parse [SECTION N] markers — strip any preamble before first [SECTION
      console.log(`[voiceover] Gemini narration raw output (${narrationResult.text.length} chars):\n${narrationResult.text.slice(0, 500)}`)
      const firstSectionIdx = narrationResult.text.indexOf('[SECTION')
      const scriptText = firstSectionIdx >= 0 ? narrationResult.text.slice(firstSectionIdx) : narrationResult.text
      const rawSegments = scriptText.split(/\[SECTION \d+\]\s*\n?/).filter((s) => s.trim())
      console.log(`[voiceover] Parsed ${rawSegments.length} sections from Gemini (expected ${numSteps})`)
      const stepsWithText = timestamps.map((_, i) => {
        const text = rawSegments[i]?.trim() ?? `Section ${i + 1}`
        return { stepIndex: i, text }
      })
      for (const s of stepsWithText) {
        console.log(`[voiceover] Step ${s.stepIndex}: "${s.text.slice(0, 80)}${s.text.length > 80 ? '...' : ''}" (${s.text.length} chars)`)
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

      // Synthesize new audio
      const buffer = await synthesizeSpeech(text, { voiceId: body.voiceId })
      const segPath = `runs/${params.data.id}/voiceover-step-${body.stepIndex}.mp3`
      await uploadToStorage('artifacts', segPath, buffer, 'audio/mpeg')
      const audioUrl = getPublicUrl('artifacts', segPath) ?? ''

      // Update the segment in the summary
      const updatedSegments = voiceover.segments.map((s) =>
        (s.stepIndex as number) === body.stepIndex
          ? { ...s, audioUrl, audioPath: segPath, text }
          : s,
      )
      const { updateRunSummary } = await import('./run.repository.js')
      await updateRunSummary(params.data.id, {
        ...summary,
        voiceover: { ...voiceover, segments: updatedSegments },
      })

      res.status(200).json({ stepIndex: body.stepIndex, audioUrl, text })
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
