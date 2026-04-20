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

      const numStepsMerged = mergedTimestamps.length
      const timeBudgets = mergedTimestamps.map((t, i) => {
        const next = mergedTimestamps[i + 1]
        if (next != null) return next - t
        // Last segment: cap at video end, min 5s
        return Math.max(5, estimatedVideoEnd - t)
      })
      const totalVideoTime = (mergedTimestamps[mergedTimestamps.length - 1] ?? 0) - (mergedTimestamps[0] ?? 0) + 15
      const totalMaxWords = Math.floor(totalVideoTime * 2)
      const sectionList = mergedTimestamps.map((t, i) => {
        const budget = timeBudgets[i]!
        const minWords = Math.max(4, Math.floor(budget * 1.5))
        const maxWords = Math.max(6, Math.floor(budget * 2.0))
        const nextT = mergedTimestamps[i + 1]
        const timeRange = nextT != null ? `${formatTime(t)}–${formatTime(nextT)}` : `${formatTime(t)}–end`
        return `[SECTION ${i + 1}] (${timeRange}, ${budget.toFixed(0)}s → ${minWords}-${maxWords} words)`
      }).join('\n')

      function formatTime(s: number): string {
        const m = Math.floor(s / 60)
        const sec = Math.floor(s % 60)
        return `${m}:${sec.toString().padStart(2, '0')}`
      }

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
- Detect the language of the **Documentation context** above (the markdown under "## Documentation context"). That is the source of truth for the narration's language.
- Write the ENTIRE narration in that same language. Do not translate, do not switch mid-script, do not mix languages.
- Ignore the language of the video's on-screen UI, the language of the spoken audio in the video, and any tone/examples below — those are just style references. Only the doc's language determines the narration's language.
- If the doc is in English, the narration is 100% English. If the doc is in French, the narration is 100% French. Same for every other language.
- When narrating a UI element whose on-screen label is in a different language than the doc, keep the label verbatim in quotes but describe the action in the doc's language: e.g. doc in English, button labelled "Paramètres" → "Click 'Paramètres' to open the settings panel."

## Content rules
- WATCH THE VIDEO: describe what you SEE happening, not what the doc says
- ANTICIPATORY: narrate what's ABOUT to happen, just before it does
- GREETING: Section 1 starts with a short, product-focused opener (one line, not verbose — get into the content quickly)
- CLOSING: Section ${numStepsMerged} MUST end with a short, warm closing in the doc's language — a one-sentence recap + a friendly sign-off. Don't skip this.
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
        const maxWords = Math.max(5, Math.floor(budget * 2.0))
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
        const limit = Math.max(5, Math.floor(budget * 2.0))
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
