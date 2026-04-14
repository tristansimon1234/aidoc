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
      const doc = await runService.generateDoc(params.data.id)
      res.status(200).json(doc)
    } catch (err) {
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

      // Get run steps and timestamps for synced narration
      const run = await runService.getRun(params.data.id)
      if (!run) throw new AppError('Run not found', 'RUN_NOT_FOUND', 404)

      const runSteps = await runService.getRunSteps(params.data.id)
      if (runSteps.length === 0) {
        throw new AppError('No steps found for this run', 'NO_STEPS', 404)
      }

      // Build narration script from step descriptions using Gemini
      const { generateText } = await import('../../shared/ai/gemini.client.js')
      const stepDescriptions = runSteps.map((s) =>
        `Step ${s.stepIndex + 1}: ${s.action ?? ''}\nScreen: ${s.observation ?? ''}`,
      ).join('\n\n')

      const narrationResult = await generateText({
        userPrompt: `You are a warm, professional video tutorial narrator — think of a friendly tech YouTuber.

Write a voice-over script for a screen recording walkthrough. This text will be synthesized by a text-to-speech engine, so write it to SOUND great when read aloud.

STYLE RULES:
- Use natural speech patterns: contractions ("let's", "you'll", "it's"), filler phrases ("alright", "so", "now")
- Add short pauses with "..." between phrases for breathing room
- Use emphasis by capitalizing key words sparingly ("click the SAVE button")
- Address the viewer as "you" — make it personal
- Use smooth transitions: "Alright...", "So now...", "Perfect — next...", "And that's it!"
- Keep each step to 1-2 short sentences — don't over-explain
- Sound enthusiastic but not over the top
- Start with a brief intro and end with a wrap-up

Steps:
${stepDescriptions}

Return EXACTLY one line per step, prefixed with the step number:
1. Alright... so here we are on the dashboard. Let's get you set up!
2. Go ahead and click on "Settings" in the top right... this is where you'll configure everything.
etc.

Write ${runSteps.length} lines total. No extra commentary — ONLY the numbered lines.`,
        maxTokens: 4096,
      })

      // Parse per-step narrations
      const lines = narrationResult.text.split('\n').filter((l) => l.trim())
      const stepsWithText = runSteps.map((s, i) => {
        const line = lines.find((l) => l.match(new RegExp(`^${i + 1}[.)]`)))
        const text = line ? line.replace(/^\d+[.)]\s*/, '') : s.action ?? `Step ${i + 1}`
        return { stepIndex: s.stepIndex, text }
      })

      // Get timestamps from run summary
      const summary = run.summaryJson as Record<string, unknown> | null
      const timestamps = (summary?.stepTimestamps as number[]) ?? runSteps.map((_, i) => i * 5)

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
