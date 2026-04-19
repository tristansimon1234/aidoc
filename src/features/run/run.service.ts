import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { Run, RunStep, CreateRunInput } from './run.types.js'
import type { TryDocReport } from '../documentation/documentation.types.js'
import * as runRepo from './run.repository.js'
import { exploreRun, type RunDeps } from '../exploration/exploration.service.js'
import type { StepEvent } from '../exploration/exploration.types.js'
import * as questionRepo from '../../features/questions/questions.repository.js'
import { generateAndSaveDoc } from '../documentation/documentation.service.js'
import { incrementUsage, findTeamIdByRunId } from '../../shared/usage/usage.repository.js'
import type { DocDeps } from '../documentation/documentation.service.js'
import type { GeneratedDoc } from '../documentation/documentation.types.js'
import type { PageBriefingWithContent } from '../page/page.types.js'
import type { ProjectContext } from '../project/project.types.js'

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
    findQuestionsByRunId: (runId) =>
      questionRepo.findQuestionsByRunId(runId).then((qs) =>
        qs.map((q) => ({ question: q.question, answer: q.answer })),
      ),
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
  const answeredQuestions = await questionRepo.findQuestionsByRunId(id)
  const answeredContext = answeredQuestions
    .filter((q) => q.answer)
    .map((q) => `Previously blocked: ${q.question}\nUser's response: ${q.answer}`)
    .join('\n\n')

  const fullContext = [additionalContext, answeredContext].filter(Boolean).join('\n\n') || undefined

  const isTryDoc = run.featureName.startsWith('[Test]')

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
        questionRepo.createQuestion({
          runId: id,
          stepId: null,
          question: event.message,
        }).catch((err) => console.error('Failed to save question:', err))
      }
    },
  })
}

export async function generateDoc(id: string): Promise<GeneratedDoc> {
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

  return doc
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


export async function getRun(id: string): Promise<Run> {
  const run = await runRepo.findRunById(id)
  if (!run) throw new NotFoundError('Run')
  return run
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
  const questions = await questionRepo.findQuestionsByRunId(runId)
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
