import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { Run, RunStep, CreateRunInput } from './run.types.js'
import type { TryDocReport } from '../documentation/documentation.types.js'
import * as runRepo from './run.repository.js'
import { exploreRun, type RunDeps } from '../exploration/exploration.service.js'
import type { StepEvent } from '../exploration/exploration.types.js'
import { generateAndSaveDoc } from '../documentation/documentation.service.js'
import { incrementUsage, findTeamIdByRunId } from '../../shared/usage/usage.repository.js'
import { findMember } from '../team/team.repository.js'
import type { DocDeps } from '../documentation/documentation.service.js'
import type { GeneratedDoc } from '../documentation/documentation.types.js'
import type { PageBriefingWithContent } from '../page/page.types.js'
import type { ProjectContext } from '../project/project.types.js'

/** Lazy-load the questions repository. Keeps the cross-feature surface
 *  behind a single indirection and defers the import until it's needed,
 *  so run.service doesn't pull the questions module at top level. */
async function getQuestionRepo(): Promise<typeof import('../questions/questions.repository.js')> {
  return import('../questions/questions.repository.js')
}

function buildRunDeps(): RunDeps {
  return {
    findRunById: runRepo.findRunById,
    updateRunStatus: runRepo.updateRunStatus,
    incrementTokenUsage: runRepo.incrementTokenUsage,
    setBrowserbaseSessionId: runRepo.setBrowserbaseSessionId,
    createRunStep: runRepo.createRunStep,
    countSteps: runRepo.countStepsByRunId,
    findStepsByRunId: runRepo.findStepsByRunId,
  }
}

function buildDocDeps(): DocDeps {
  return {
    findRunById: runRepo.findRunById,
    findStepsByRunId: runRepo.findStepsByRunId,
    findQuestionsByRunId: async (runId) => {
      const repo = await getQuestionRepo()
      const qs = await repo.findQuestionsByRunId(runId)
      return qs.map((q) => ({ question: q.question, answer: q.answer }))
    },
    incrementTokenUsage: runRepo.incrementTokenUsage,
  }
}

function formatProjectContext(ctx: ProjectContext | null): string {
  if (!ctx) return ''
  const parts: string[] = []
  if (ctx.audience) parts.push(`**Target audience**: ${ctx.audience}`)
  if (ctx.workflow) parts.push(`**Key workflow**: ${ctx.workflow}`)
  if (ctx.quirks) parts.push(`**Non-obvious behaviors / terminology**: ${ctx.quirks}`)
  return parts.join('\n')
}

// Fetch project context + page siblings for cross-page awareness
async function getProjectAwareness(docPageId: string): Promise<{
  projectId: string | undefined
  projectContext: string | undefined
  tableOfContents: string | undefined
  credentials: { label: string; username: string; password: string }[] | undefined
  customPrompt: string | undefined
  briefing: PageBriefingWithContent | undefined
  existingPageSummaries: { title: string; slug: string; contentPreview: string }[] | undefined
  knownSlugs: string[] | undefined
}> {
  const { findPageById, findPagesByProjectId } = await import('../page/page.repository.js')
  const { findProjectById } = await import('../project/project.repository.js')

  const page = await findPageById(docPageId)
  if (!page) return { projectId: undefined, projectContext: undefined, tableOfContents: undefined, credentials: undefined, customPrompt: undefined, briefing: undefined, existingPageSummaries: undefined, knownSlugs: undefined }

  const project = await findProjectById(page.projectId)
  if (!project) return { projectId: page.projectId, projectContext: undefined, tableOfContents: undefined, credentials: undefined, customPrompt: page.customPrompt ?? undefined, briefing: page.briefing ?? undefined, existingPageSummaries: undefined, knownSlugs: undefined }

  // Build table of contents from sibling pages — only published public pages,
  // so the AI can only produce cross-links to URLs that actually exist on the
  // public docs site. Draft/private pages are hidden from the prompt.
  const allPages = await findPagesByProjectId(page.projectId)
  const linkablePages = allPages.filter((p) => p.id !== docPageId && p.isPublic)
  const toc = linkablePages
    .map((p) => {
      const indent = p.parentId ? '  ' : ''
      return `${indent}- ${p.title} [${p.status}] — /${p.slug}`
    })
    .join('\n')

  // Build page content summaries
  const summaries = linkablePages
    .filter((p) => p.content)
    .map((p) => ({
      title: p.title,
      slug: p.slug,
      contentPreview: (p.content ?? '').slice(0, 200).replace(/\n/g, ' '),
    }))

  // Combine user context with discovered context
  let fullProjectContext = formatProjectContext(project.context)
  if (project.discoveredContext?.summary) {
    fullProjectContext += `\n\n## What the AI has learned about this product\n${project.discoveredContext.summary}`
    if (project.discoveredContext.features?.length) {
      fullProjectContext += `\nKnown features: ${project.discoveredContext.features.join(', ')}`
    }
    if (project.discoveredContext.navigation?.length) {
      fullProjectContext += `\nNavigation items: ${project.discoveredContext.navigation.join(', ')}`
    }
    if (project.discoveredContext.terminology && Object.keys(project.discoveredContext.terminology).length > 0) {
      const terms = Object.entries(project.discoveredContext.terminology)
        .map(([term, def]) => `- **${term}**: ${def}`)
        .join('\n')
      fullProjectContext += `\nProduct terminology:\n${terms}`
    }
    if (project.discoveredContext.siteStructure?.length) {
      fullProjectContext += `\nKnown site pages: ${project.discoveredContext.siteStructure.join(', ')}`
    }
  }

  // Filter project resources by page-level selection
  const allProjectResources = project.resources ?? []
  const rawBriefing = page.briefing as Record<string, unknown> | null
  const selectedIndices = (rawBriefing?.selectedResources as number[] | undefined) ?? []
  const selectedProjectResources = selectedIndices.length > 0
    ? allProjectResources.filter((_, i) => selectedIndices.includes(i))
    : []

  const knownSlugs = linkablePages.map((p) => p.slug)

  return {
    projectId: page.projectId,
    projectContext: fullProjectContext.trim() || undefined,
    tableOfContents: toc || undefined,
    credentials: project.credentials ?? undefined,
    customPrompt: page.customPrompt ?? undefined,
    briefing: await enrichBriefingWithFileContents(page.briefing, selectedProjectResources.length > 0 ? selectedProjectResources : undefined),
    existingPageSummaries: summaries.length > 0 ? summaries : undefined,
    knownSlugs: knownSlugs.length > 0 ? knownSlugs : undefined,
  }
}

async function enrichBriefingWithFileContents(
  briefing: import('../page/page.types.js').PageBriefing | null,
  projectResources?: import('../project/project.types.js').ProjectResource[],
): Promise<PageBriefingWithContent | undefined> {
  if (!briefing) return undefined

  // Merge project-level resources into page briefing resources
  const projRes = (projectResources ?? []).map((r) => ({ type: r.type, label: r.label, value: r.value }))
  const allResources = [...(briefing.resources ?? []), ...projRes]

  const { downloadFromStorage } = await import('../../shared/db/storage.repository.js')
  const enrichedResources = await Promise.all(
    allResources.map(async (r) => {
      if (r.type !== 'file' || !r.value) return r
      try {
        console.log(`[briefing] Downloading file resource: ${r.value}`)
        const buffer = await downloadFromStorage('briefing-files', r.value)
        if (!buffer) {
          console.error(`[briefing] Failed to download ${r.value}`)
          return r
        }
        const fileName = r.value.split('/').pop() ?? r.label
        console.log(`[briefing] Loaded ${r.label}: ${buffer.length} bytes`)
        return { ...r, fileBuffer: buffer, fileName }
      } catch (err) {
        console.error(`[briefing] Error loading file ${r.value}:`, err)
        return r
      }
    }),
  )

  return {
    objective: briefing.objective,
    knowledge: briefing.knowledge,
    resources: enrichedResources,
  }
}

export async function createRun(input: CreateRunInput): Promise<Run> {
  return runRepo.createRun(input)
}

export async function exploreWithEvents(
  id: string,
  onEvent: (event: StepEvent) => void,
  additionalContext?: string,
): Promise<void> {
  const run = await runRepo.findRunById(id)
  if (!run) throw new NotFoundError('Run')

  if (run.status !== 'pending' && run.status !== 'blocked' && run.status !== 'failed') {
    throw new NotFoundError('Run is not in an explorable state')
  }

  // Fetch full project awareness if linked to a page
  let awareness: Awaited<ReturnType<typeof getProjectAwareness>> = {
    projectId: undefined,
    projectContext: undefined,
    tableOfContents: undefined,
    credentials: undefined,
    customPrompt: undefined,
    briefing: undefined,
    existingPageSummaries: undefined,
    knownSlugs: undefined,
  }
  if (run.docPageId) {
    awareness = await getProjectAwareness(run.docPageId)
  }

  // Merge answered questions into the context for resume
  const questionsRepo = await getQuestionRepo()
  const answeredQuestions = await questionsRepo.findQuestionsByRunId(id)
  const answeredContext = answeredQuestions
    .filter((q) => q.answer)
    .map((q) => `Previously blocked: ${q.question}\nUser's response: ${q.answer}`)
    .join('\n\n')

  const isTryDoc = run.featureName.startsWith('[Test]')

  // For Try Doc runs, override the caller-provided additionalContext with
  // the canonical STRICT TESTER prompt built from the linked page. Keeps
  // all prompt text in prompt.builder.ts (Hard Rule #3) and prevents the
  // frontend from shipping its own prompt string over the wire.
  let effectiveAdditionalContext = additionalContext
  if (isTryDoc && run.docPageId) {
    const { findPageById } = await import('../page/page.repository.js')
    const page = await findPageById(run.docPageId)
    if (page?.content) {
      const { buildTryDocExplorationPrompt } = await import('../../shared/ai/prompt.builder.js')
      const rawBriefing = page.briefing as Record<string, unknown> | null
      const testUrl = (rawBriefing?.testUrl as string | undefined)
        ?? page.startUrl
        ?? run.startUrl
      const testNotes = (rawBriefing?.testNotes as string | undefined) ?? null
      effectiveAdditionalContext = buildTryDocExplorationPrompt({
        pageContent: page.content,
        testUrl,
        testNotes,
      })
    }
  }

  const fullContext = [effectiveAdditionalContext, answeredContext].filter(Boolean).join('\n\n') || undefined

  await exploreRun(id, buildRunDeps(), {
    additionalContext: fullContext,
    projectContext: awareness.projectContext,
    tableOfContents: awareness.tableOfContents,
    credentials: awareness.credentials,
    customPrompt: awareness.customPrompt,
    briefing: awareness.briefing,
    skipScreenshots: isTryDoc,
    onEvent: (event) => {
      onEvent(event)

      // Persist the structured summary
      if (event.type === 'summary' && event.summary) {
        runRepo.updateRunSummary(id, event.summary as unknown as Record<string, unknown>)
          .catch((err) => console.error('Failed to save run summary:', err))
      }

      // Save blocker as question for the user to answer
      if (event.type === 'blocked' && event.message) {
        getQuestionRepo()
          .then((repo) => repo.createQuestion({ runId: id, stepId: null, question: event.message ?? '' }))
          .catch((err) => console.error('Failed to save question:', err))
      }
    },
  })
}

export async function generateDoc(id: string, triggeredByUserId: string | null = null): Promise<GeneratedDoc> {
  const run = await runRepo.findRunById(id)
  if (!run) throw new NotFoundError('Run')
  if (run.status === 'pending') {
    throw new NotFoundError('Run has not started yet')
  }
  // If run is stuck as 'running' (e.g. Vercel timeout killed the function),
  // recover it as 'failed' so we can still generate doc from partial data
  if (run.status === 'running') {
    await runRepo.updateRunStatus(id, 'failed')
  }

  // Fetch project awareness for cross-page context in doc generation
  let docOptions: { projectContext?: string; tableOfContents?: string; existingPageSummaries?: { title: string; slug: string; contentPreview: string }[]; projectId?: string; knownSlugs?: string[] } | undefined
  if (run.docPageId) {
    const awareness = await getProjectAwareness(run.docPageId)
    const briefingContext = awareness.briefing
      ? [
          awareness.briefing.objective ? `Page objective: ${awareness.briefing.objective}` : '',
          awareness.briefing.knowledge ? `Domain knowledge: ${awareness.briefing.knowledge}` : '',
        ].filter(Boolean).join('\n')
      : ''
    docOptions = {
      projectContext: [awareness.projectContext, briefingContext].filter(Boolean).join('\n\n') || undefined,
      tableOfContents: awareness.tableOfContents,
      existingPageSummaries: awareness.existingPageSummaries,
      projectId: awareness.projectId,
      knownSlugs: awareness.knownSlugs,
    }
  }

  const doc = await generateAndSaveDoc(id, buildDocDeps(), docOptions)

  // Metered: bump monthly doc_run counter on the owning team
  try {
    const teamId = await findTeamIdByRunId(id)
    if (teamId) await incrementUsage(teamId, 'doc_run')
  } catch (err) {
    console.warn('[usage] increment doc_run failed:', (err as Error).message)
  }

  // FIX 4: page.content is THE source of truth — write synchronously, no silent catch
  if (run.docPageId && doc.markdownContent) {
    const { updatePageContent, findPageById } = await import('../page/page.repository.js')
    await updatePageContent(run.docPageId, doc.markdownContent)

    // Re-index embeddings for chat (fire-and-forget)
    findPageById(run.docPageId).then((p) => {
      if (p) {
        import('../chat/chat.service.js')
          .then(({ indexPage }) => indexPage({ id: p.id, projectId: p.projectId, title: p.title, slug: p.slug, content: doc.markdownContent }))
          .catch((err) => console.error('[chat] Auto-index after doc gen failed:', err))
      }
    }).catch(() => {})

    // Enrich project discovered context
    try {
      const page = await findPageById(run.docPageId)
      if (page) {
        const { findProjectById, updateDiscoveredContext } = await import('../project/project.repository.js')
        const project = await findProjectById(page.projectId)
        if (project) {
          const { buildContextEnrichmentPrompt } = await import('../../shared/ai/prompt.builder.js')
          const { generateText } = await import('../../shared/ai/gemini.client.js')
          const prompt = buildContextEnrichmentPrompt(
            project.discoveredContext,
            doc.markdownContent,
            run.featureName,
          )
          const response = await generateText({
            userPrompt: prompt,
            maxTokens: 4096,
            json: true,
          })
          {
            let jsonStr = response.text.trim()
            if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
            // Extract JSON object if surrounded by extra text
            const braceStart = jsonStr.indexOf('{')
            const braceEnd = jsonStr.lastIndexOf('}')
            if (braceStart === -1 || braceEnd <= braceStart) {
              console.warn('[context-enrichment] No valid JSON object found in response, skipping')
            } else {
              jsonStr = jsonStr.slice(braceStart, braceEnd + 1)
              let parsed
              try {
                parsed = JSON.parse(jsonStr) as unknown
              } catch {
                // JSON truncated — attempt repair
                let repaired = jsonStr
                // Remove last incomplete key-value pair
                repaired = repaired.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, '')
                repaired = repaired.replace(/,\s*\{[^}]*$/, '')
                repaired = repaired.replace(/,\s*$/, '')
                repaired = repaired.replace(/,\s*}/, '}')
                repaired = repaired.replace(/,\s*]/, ']')
                // Close open strings
                if (repaired.split('"').length % 2 === 0) repaired += '"'
                // Close open brackets/braces
                const openBrackets = (repaired.match(/\[/g) ?? []).length - (repaired.match(/\]/g) ?? []).length
                const openBraces = (repaired.match(/\{/g) ?? []).length - (repaired.match(/\}/g) ?? []).length
                repaired += ']'.repeat(Math.max(0, openBrackets))
                repaired += '}'.repeat(Math.max(0, openBraces))
                try {
                  parsed = JSON.parse(repaired) as unknown
                  console.warn('[context-enrichment] Repaired truncated JSON')
                } catch {
                  console.warn('[context-enrichment] JSON repair failed, skipping enrichment')
                }
              }
              if (parsed) {
                const { DiscoveredContextSchema } = await import('../project/project.schema.js')
                const validated = DiscoveredContextSchema.safeParse(parsed)
                if (validated.success) {
                  await updateDiscoveredContext(project.id, validated.data)
                } else {
                  console.error('Context enrichment validation failed:', validated.error.flatten())
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to enrich project context:', err)
    }
  }

  // Mark run completed so Realtime triggers frontend notification
  await runRepo.updateRunStatus(id, 'completed')

  // Notify teammates that a new doc is ready to review. Best-effort: any
  // failure here (Resend down, missing EMAIL_FROM, team_id lookup failure)
  // must not fail the doc gen itself — the user already sees success.
  try {
    await notifyTeamDocReady(run, triggeredByUserId)
  } catch (err) {
    console.warn('[doc-ready-email] notify failed:', (err as Error).message)
  }

  return doc
}

/**
 * Fire "a new doc is ready" emails to every team member except the one who
 * triggered the generation. Silently skips when EMAIL infra or PUBLIC_APP_URL
 * isn't configured — no point emailing if the accept link would 404.
 */
async function notifyTeamDocReady(run: Awaited<ReturnType<typeof runRepo.findRunById>>, triggeredByUserId: string | null): Promise<void> {
  if (!run || !run.docPageId) return
  const { env } = await import('../../shared/config/env.js')
  if (!env.PUBLIC_APP_URL || !env.RESEND_API_KEY || !env.EMAIL_FROM) return

  const [{ findPageById }, { findProjectById }] = await Promise.all([
    import('../page/page.repository.js'),
    import('../project/project.repository.js'),
  ])
  const page = await findPageById(run.docPageId)
  if (!page) return
  const project = await findProjectById(page.projectId)
  if (!project) return

  const { listMembers, findTeamById } = await import('../team/team.repository.js')
  const [members, team] = await Promise.all([
    listMembers(project.teamId),
    findTeamById(project.teamId),
  ])
  if (!team || members.length === 0) return

  // Resolve the triggerer's display name — "Alice generated X" reads better
  // than "a teammate generated X". Fall back gracefully when the lookup fails.
  let triggeredByName = 'A teammate'
  if (triggeredByUserId) {
    const { findProfileById } = await import('../profile/profile.repository.js')
    const profile = await findProfileById(triggeredByUserId).catch(() => null)
    triggeredByName = profile?.fullName ?? profile?.email ?? 'A teammate'
  }

  const reviewUrl = `${env.PUBLIC_APP_URL}/projects/${project.id}/pages/${page.id}`
  const { buildDocReadyEmail } = await import('../../shared/email/templates/doc-ready.js')
  const { sendEmail } = await import('../../shared/email/resend.client.js')
  const { subject, html } = buildDocReadyEmail({
    teamName: team.name,
    triggeredByName,
    projectName: project.name,
    pageTitle: page.title,
    reviewUrl,
  })

  await Promise.all(
    members
      .filter((m) => m.email && m.userId !== triggeredByUserId)
      .map((m) => sendEmail({ to: m.email as string, subject, html }).catch(() => ({ sent: false }))),
  )
}

export async function cancelExploration(id: string): Promise<void> {
  const run = await runRepo.findRunById(id)
  if (!run) throw new NotFoundError('Run')
  if (run.status !== 'running') throw new NotFoundError('Run is not running')
  const { cancelRun } = await import('../exploration/exploration.service.js')
  cancelRun(id)
}

export async function analyzeVideo(runId: string, videoPath: string): Promise<{ timestamps: number[]; framesExtracted: boolean }> {
  const run = await runRepo.findRunById(runId)
  if (!run) throw new NotFoundError('Run')

  await runRepo.updateRunStatus(runId, 'running')

  try {
    // --- Step 1: Convert to MP4 via video microservice ---
    const { isVideoServiceConfigured, convertToMp4, extractFrames: extractFramesRemote } = await import('../../shared/video/video.client.js')

    let analyzeVideoPath = videoPath
    let playerVideoPath = videoPath

    if (isVideoServiceConfigured() && !videoPath.endsWith('.mp4')) {
      try {
        const mp4Path = await convertToMp4(videoPath, runId)
        analyzeVideoPath = mp4Path
        playerVideoPath = mp4Path
      } catch (err) {
        console.warn(`[video] Conversion failed, using original: ${(err as Error).message}`)
      }
    }
    console.log(`[video] Using video: ${analyzeVideoPath}`)

    // --- Step 2: Download for Gemini analysis ---
    console.log(`[video] Step 2: Download ${analyzeVideoPath} from storage`)
    const { downloadFromStorage } = await import('../../shared/db/storage.repository.js')
    const buffer = await downloadFromStorage('artifacts', analyzeVideoPath)
    if (!buffer) {
      console.error(`[video] Download FAILED`)
      throw new Error(`Failed to download video: ${analyzeVideoPath}`)
    }
    const mimeType = analyzeVideoPath.endsWith('.mp4') ? 'video/mp4'
      : analyzeVideoPath.endsWith('.webm') ? 'video/webm'
      : 'video/quicktime'
    const fileName = analyzeVideoPath.split('/').pop() ?? 'video.mp4'

    // --- Step 3: Analyze with Gemini ---
    const { analyzeVideoWithGemini, correctTimestamps } = await import('../../shared/ai/gemini.client.js')
    const analysis = await analyzeVideoWithGemini(buffer, mimeType, fileName)

    console.log(`[video] Gemini returned ${analysis.steps.length} steps (raw):`)
    for (const s of analysis.steps) {
      console.log(`  [${s.timestamp.toFixed(1)}s] ${s.userAction}`)
    }

    if (analysis.steps.length === 0) {
      await runRepo.updateRunStatus(runId, 'failed')
      throw new Error('Could not detect any actions in the video. Try a longer recording with clear interactions.')
    }

    // --- Step 3b: Correct MM:SS concatenation bug ---
    const { probeVideo } = await import('../../shared/video/video.client.js')
    let videoDuration = Infinity
    if (isVideoServiceConfigured()) {
      try {
        const probe = await probeVideo(playerVideoPath)
        videoDuration = probe.durationSeconds
      } catch (err) {
        console.warn(`[video] Probe failed, skipping timestamp correction: ${(err as Error).message}`)
      }
    }

    const correctedSteps = correctTimestamps(analysis.steps, videoDuration)
    const sortedSteps = [...correctedSteps].sort((a, b) => a.timestamp - b.timestamp)

    // Safety-net clamp: a Gemini timestamp that bleeds into the next step
    // produces a screenshot of the wrong state. Cap each step at
    // `next.timestamp - 0.6s` so frames never show the start of step i+1.
    // Only clamps downward; the prompt is responsible for picking the right
    // moment within the step's own window.
    const SAFETY_GAP = 0.6
    for (let i = 0; i < sortedSteps.length - 1; i++) {
      const next = sortedSteps[i + 1]!
      const ceil = Math.max(0, next.timestamp - SAFETY_GAP)
      if (sortedSteps[i]!.timestamp > ceil) sortedSteps[i]!.timestamp = ceil
    }

    console.log(`[video] Final ${sortedSteps.length} steps:`)
    for (const s of sortedSteps) {
      console.log(`  [${s.timestamp.toFixed(1)}s] ${s.userAction}`)
    }

    const timestamps = sortedSteps.map((s) => s.timestamp)

    // --- Step 4: Extract frames via video microservice ---
    let framesExtracted = false
    let framePaths: (string | null)[] = []

    if (isVideoServiceConfigured()) {
      try {
        framePaths = await extractFramesRemote(playerVideoPath, runId, timestamps)
        framesExtracted = framePaths.some((p) => p !== null)
      } catch (err) {
        console.warn(`[video] Frame extraction failed: ${(err as Error).message}`)
      }
    }

    // --- Step 5: Create run steps ---
    for (let i = 0; i < sortedSteps.length; i++) {
      const s = sortedSteps[i]!
      const narrationText = s.narration ? `\nNarration: ${s.narration}` : ''
      await runRepo.createRunStep({
        runId,
        stepIndex: i,
        title: s.userAction,
        action: s.userAction,
        observation: `${s.screenDescription}${narrationText}`,
        screenshotPath: framePaths[i] ?? undefined,
        status: 'completed',
      })
    }

    // --- Step 6: Summary ---
    await runRepo.updateRunSummary(runId, {
      sections: [{
        url: 'video',
        label: analysis.productName || run.featureName,
        status: 'documented',
        stepCount: sortedSteps.length,
      }],
      blockers: [],
      agentMessage: analysis.summary,
      videoPath: playerVideoPath,
      stepTimestamps: timestamps,
    })

    await runRepo.updateRunStatus(runId, 'completed')

    return { timestamps, framesExtracted }
  } catch (err) {
    console.error(`[video] Analysis failed for run ${runId}:`, err)
    await runRepo.updateRunStatus(runId, 'failed')
    throw err
  }
}

/**
 * Whether the async long-video pipeline (compress + chunk + Gemini off Vercel)
 * is available. Requires the video-service plus the callback wiring; when any
 * piece is missing we fall back to the inline path so short recordings keep
 * working without extra config.
 */
export async function isAsyncVideoPipelineEnabled(): Promise<boolean> {
  const { env } = await import('../../shared/config/env.js')
  const { isVideoServiceConfigured } = await import('../../shared/video/video.client.js')
  return Boolean(
    isVideoServiceConfigured() &&
      env.PUBLIC_API_URL &&
      env.INTERNAL_CALLBACK_SECRET &&
      env.GEMINI_API_KEY,
  )
}

/**
 * Hand a recording off to the video-service for async processing. Returns once
 * the worker has accepted the job (HTTP 202); the heavy work (compress, chunk,
 * Gemini, frame extraction) runs out-of-band on Railway and reports back via
 * `finalizeExternalVideoAnalysis`. The job row stays `running` until then.
 *
 * The recording stays in `running` so the UI shows progress; a failure to even
 * dispatch is surfaced to the caller (which fails the job).
 */
export async function dispatchAsyncVideoAnalysis(input: {
  runId: string
  videoPath: string
  jobId: string
  triggeredByUserId: string | null
}): Promise<void> {
  const { env } = await import('../../shared/config/env.js')
  const { processAndAnalyze } = await import('../../shared/video/video.client.js')
  const { buildVideoAnalysisPrompt } = await import('../../shared/ai/prompt.builder.js')

  if (!env.PUBLIC_API_URL || !env.INTERNAL_CALLBACK_SECRET || !env.GEMINI_API_KEY) {
    throw new Error('Async video pipeline is not configured')
  }

  await runRepo.updateRunStatus(input.runId, 'running')

  // The worker analyses each ~10-minute chunk independently, so the prompt is
  // built for a segment of that length rather than the whole recording.
  const CHUNK_SECONDS = 600
  const callbackUrl = `${env.PUBLIC_API_URL.replace(/\/$/, '')}/internal/video-analysis-callback`

  await processAndAnalyze({
    runId: input.runId,
    videoPath: input.videoPath,
    jobId: input.jobId,
    triggeredByUserId: input.triggeredByUserId,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: 'gemini-2.5-flash',
    analysisPrompt: buildVideoAnalysisPrompt({ segmentSeconds: CHUNK_SECONDS }),
    callbackUrl,
    callbackSecret: env.INTERNAL_CALLBACK_SECRET,
    chunkSeconds: CHUNK_SECONDS,
  })
}

/**
 * Persist the result of an async video analysis (delivered by the
 * video-service callback) and run the rest of the doc pipeline: write the run
 * steps + summary, generate the doc, publish the linked page, and complete the
 * job. Mirrors the inline `analyze-video` + `generate-doc` path, minus the
 * analysis itself (already done off-Vercel). The worker has already corrected
 * timestamps, sorted, clamped and extracted frames — we trust the validated
 * shape, not the values, and simply persist.
 */
export async function finalizeExternalVideoAnalysis(payload: {
  runId: string
  jobId: string
  triggeredByUserId: string | null
  productName: string
  summary: string
  videoPath?: string
  steps: { timestamp: number; screenDescription: string; userAction: string; narration: string | null; screenshotPath: string | null }[]
}): Promise<void> {
  const { completeJob, failJob } = await import('./job.service.js')

  try {
    const run = await runRepo.findRunById(payload.runId)
    if (!run) throw new NotFoundError('Run')

    if (payload.steps.length === 0) {
      throw new Error('Video analysis returned no steps')
    }

    const sortedSteps = [...payload.steps].sort((a, b) => a.timestamp - b.timestamp)
    const timestamps = sortedSteps.map((s) => s.timestamp)

    for (let i = 0; i < sortedSteps.length; i++) {
      const s = sortedSteps[i]!
      const narrationText = s.narration ? `\nNarration: ${s.narration}` : ''
      await runRepo.createRunStep({
        runId: payload.runId,
        stepIndex: i,
        title: s.userAction,
        action: s.userAction,
        observation: `${s.screenDescription}${narrationText}`,
        screenshotPath: s.screenshotPath ?? undefined,
        status: 'completed',
      })
    }

    await runRepo.updateRunSummary(payload.runId, {
      sections: [{
        url: 'video',
        label: payload.productName || run.featureName,
        status: 'documented',
        stepCount: sortedSteps.length,
      }],
      blockers: [],
      agentMessage: payload.summary,
      videoPath: payload.videoPath ?? undefined,
      stepTimestamps: timestamps,
    })

    await runRepo.updateRunStatus(payload.runId, 'completed')

    // Generate the doc + publish the page — same as the inline generateDoc branch.
    await generateDoc(payload.runId, payload.triggeredByUserId)
    if (run.docPageId) {
      const { updatePage } = await import('../page/page.repository.js')
      await updatePage(run.docPageId, { status: 'published' })
    }

    await completeJob(payload.jobId)
  } catch (err) {
    console.error(`[video] Finalize failed for run ${payload.runId}:`, err)
    await runRepo.updateRunStatus(payload.runId, 'failed').catch(() => {})
    await failJob(payload.jobId, (err as Error).message).catch(() => {})
    throw err
  }
}

/** Mark an async analysis job failed when the worker reports an error. */
export async function failExternalVideoAnalysis(input: {
  runId: string
  jobId: string
  error: string
}): Promise<void> {
  const { failJob } = await import('./job.service.js')
  await runRepo.updateRunStatus(input.runId, 'failed').catch(() => {})
  await failJob(input.jobId, input.error).catch(() => {})
}


export async function getRun(id: string): Promise<Run> {
  const run = await runRepo.findRunById(id)
  if (!run) throw new NotFoundError('Run')
  return run
}

/** Assert the caller is a member of the team that owns the run. Returns
 *  404 on both "doesn't exist" and "no access" so callers can't enumerate
 *  run ids across teams. Used by every authed route touching a run. */
export async function assertRunAccess(runId: string, userId: string): Promise<void> {
  const teamId = await findTeamIdByRunId(runId)
  if (!teamId) throw new NotFoundError('Run')
  const member = await findMember(teamId, userId)
  if (!member) throw new NotFoundError('Run')
}

export async function getLatestRunByPageId(pageId: string): Promise<Run | null> {
  return runRepo.findLatestRunByPageId(pageId)
}

export async function listRuns(): Promise<Run[]> {
  return runRepo.listRuns()
}

export async function getRunSteps(runId: string): Promise<RunStep[]> {
  const run = await runRepo.findRunById(runId)
  if (!run) throw new NotFoundError('Run')
  return runRepo.findStepsByRunId(runId)
}

export async function getQuestions(runId: string): Promise<{ id: string; question: string; answer: string | null }[]> {
  const repo = await getQuestionRepo()
  const questions = await repo.findQuestionsByRunId(runId)
  return questions.map((q) => ({ id: q.id, question: q.question, answer: q.answer }))
}

export async function analyzeTryDoc(
  runId: string,
  pageContent: string,
  pageTitle: string,
  pageId: string,
): Promise<TryDocReport> {
  const run = await runRepo.findRunById(runId)
  if (!run) throw new NotFoundError('Run')

  const steps = await runRepo.findStepsByRunId(runId)

  const { getPublicUrl } = await import('../../shared/db/storage.repository.js')

  const stepSummaries = steps.map((s) => ({
    stepIndex: s.stepIndex,
    url: s.url,
    action: s.action,
    observation: s.observation?.slice(0, 1000) ?? null,
    status: s.status,
  }))

  const { generateText } = await import('../../shared/ai/gemini.client.js')
  const { TRY_DOC_ANALYSIS_SYSTEM_PROMPT, buildTryDocAnalysisPrompt } = await import('../../shared/ai/prompt.builder.js')

  const userPrompt = buildTryDocAnalysisPrompt(pageContent, pageTitle, stepSummaries)

  const result = await generateText({
    systemPrompt: TRY_DOC_ANALYSIS_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 16384,
  })

  // Parse and validate the Gemini response
  let jsonStr = result.text.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }
  // Extract JSON object if surrounded by extra text
  const braceStart = jsonStr.indexOf('{')
  const braceEnd = jsonStr.lastIndexOf('}')
  if (braceStart !== -1 && braceEnd > braceStart) jsonStr = jsonStr.slice(braceStart, braceEnd + 1)

  const { TryDocReportSchema } = await import('./run.schema.js')
  let parsed
  try {
    parsed = TryDocReportSchema.parse(JSON.parse(jsonStr))
  } catch (parseErr) {
    // Attempt repair: close open brackets/braces
    console.warn(`[trydoc] JSON parse failed, attempting repair: ${(parseErr as Error).message}`)
    let repaired = jsonStr
    // Remove trailing incomplete entries
    repaired = repaired.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, '')
    repaired = repaired.replace(/,\s*\{[^}]*$/, '')
    repaired = repaired.replace(/,\s*$/, '')
    repaired = repaired.replace(/,\s*}/, '}')
    repaired = repaired.replace(/,\s*]/, ']')
    // Close open strings
    if (repaired.split('"').length % 2 === 0) repaired += '"'
    // Close open brackets/braces
    const openBrackets = (repaired.match(/\[/g) ?? []).length - (repaired.match(/\]/g) ?? []).length
    const openBraces = (repaired.match(/\{/g) ?? []).length - (repaired.match(/\}/g) ?? []).length
    repaired += ']'.repeat(Math.max(0, openBrackets))
    repaired += '}'.repeat(Math.max(0, openBraces))
    try {
      parsed = TryDocReportSchema.parse(JSON.parse(repaired))
      console.log('[trydoc] JSON repaired successfully')
    } catch (repairErr) {
      throw new Error(`Failed to parse TryDoc report: ${(repairErr as Error).message}`)
    }
  }

  // Attach screenshot URLs to step results
  const stepsWithScreenshots = parsed.steps.map((stepResult) => {
    const matchingStep = steps.find((s) => s.stepIndex === stepResult.stepIndex)
    const screenshotUrl = matchingStep?.screenshotPath
      ? getPublicUrl('artifacts', matchingStep.screenshotPath)
      : null
    return { ...stepResult, screenshotPath: screenshotUrl }
  })

  const report: TryDocReport = {
    version: 1,
    pageId,
    pageTitle,
    executedAt: new Date().toISOString(),
    summary: parsed.summary,
    steps: stepsWithScreenshots,
    failures: parsed.failures,
    docIssues: parsed.docIssues,
    uxInsights: parsed.uxInsights,
    recommendations: parsed.recommendations,
    scores: parsed.scores,
  }

  // Store the report in summary_json
  await runRepo.updateRunSummary(runId, {
    ...(run.summaryJson ?? {}),
    tryDocReport: report,
  })

  // Metered: bump monthly try_doc counter on the owning team
  try {
    const teamId = await findTeamIdByRunId(runId)
    if (teamId) await incrementUsage(teamId, 'try_doc')
  } catch (err) {
    console.warn('[usage] increment try_doc failed:', (err as Error).message)
  }

  return report
}
