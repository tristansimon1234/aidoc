import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError, AppError } from '../../shared/middleware/error.middleware.js'
import { CreateRunSchema, RunIdParamSchema } from './run.schema.js'
import * as runService from './run.service.js'
import { enforceQuotaOrThrow } from '../../shared/middleware/quota.middleware.js'
import { findTeamIdByRunId } from '../../shared/usage/usage.repository.js'

export const runRouter = Router()


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

// Attach a video to a run WITHOUT running any analysis or generation —
// just writes summary_json.videoPath so the Video tab resolves the
// public URL on the next fetch. Used by the "Attach video only" flow
// on the page Video tab, for authors who already wrote their doc and
// want to add a walkthrough recording on top.
runRouter.post('/:id/attach-video', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = RunIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = req.body as { videoPath?: string }
      if (!body.videoPath || typeof body.videoPath !== 'string') {
        throw new ValidationError('videoPath is required')
      }
      const run = await runService.getRun(params.data.id)
      const existingSummary = (run.summaryJson ?? {}) as Record<string, unknown>
      const { updateRunSummary } = await import('./run.repository.js')
      await updateRunSummary(params.data.id, {
        ...existingSummary,
        videoPath: body.videoPath,
        attachedOnly: true,
      })
      res.status(200).json({ ok: true })
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

      const { isElevenLabsConfigured } = await import('../../shared/ai/elevenlabs.client.js')
      if (!isElevenLabsConfigured()) {
        throw new AppError('Voice-over requires ELEVENLABS_API_KEY to be configured', 'ELEVENLABS_NOT_CONFIGURED', 400)
      }

      const run = await runService.getRun(params.data.id)
      if (!run) throw new AppError('Run not found', 'RUN_NOT_FOUND', 404)

      // Create a DB job so the frontend tracker survives navigation + refresh.
      // MCP callers don't want jobs — they block on the JSON-RPC response —
      // so the job creation stays in the route, not the service.
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

      const { generateVoiceoverForRun } = await import('../documentation/voiceover.service.js')
      const result = await generateVoiceoverForRun(params.data.id, {
        voiceId: body.voiceId,
        language: body.language,
        tone: body.tone,
        videoDuration: body.videoDuration,
      })


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
        const { INTRO_LEAD_IN_SECONDS } = await import('../documentation/voiceover.service.js')
        const sortedSegments = [...updatedSegments].sort(
          (a, b) => (a.stepIndex as number) - (b.stepIndex as number),
        )
        const concatSegments = sortedSegments.map((s, i) => ({
          audioPath: (s.audioPath as string) ?? `runs/${params.data.id}/voiceover-seg-${s.stepIndex as number}.mp3`,
          targetStartTime: i === 0
            ? INTRO_LEAD_IN_SECONDS
            : Math.max(INTRO_LEAD_IN_SECONDS, (s.startTime as number) - 1.5),
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
        // Any previously-computed video+voiceover mux is stale — the video
        // content just changed. Export / MCP will rebuild it on next access.
        muxedVideoPath: null,
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
