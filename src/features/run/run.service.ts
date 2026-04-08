import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { Run, RunStep, CreateRunInput } from './run.types.js'
import * as runRepo from './run.repository.js'
import { exploreRun, type RunDeps } from '../exploration/exploration.service.js'
import type { StepEvent } from '../exploration/exploration.types.js'
import * as questionRepo from '../../features/questions/questions.repository.js'
import { generateAndSaveDoc } from '../documentation/documentation.service.js'
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
  projectContext: string | undefined
  tableOfContents: string | undefined
  credentials: { label: string; username: string; password: string }[] | undefined
  customPrompt: string | undefined
  briefing: PageBriefingWithContent | undefined
  existingPageSummaries: { title: string; slug: string; contentPreview: string }[] | undefined
}> {
  const { findPageById, findPagesByProjectId } = await import('../page/page.repository.js')
  const { findProjectById } = await import('../project/project.repository.js')

  const page = await findPageById(docPageId)
  if (!page) return { projectContext: undefined, tableOfContents: undefined, credentials: undefined, customPrompt: undefined, briefing: undefined, existingPageSummaries: undefined }

  const project = await findProjectById(page.projectId)
  if (!project) return { projectContext: undefined, tableOfContents: undefined, credentials: undefined, customPrompt: page.customPrompt ?? undefined, briefing: page.briefing ?? undefined, existingPageSummaries: undefined }

  // Build table of contents from sibling pages
  const allPages = await findPagesByProjectId(page.projectId)
  const toc = allPages
    .filter((p) => p.id !== docPageId)
    .map((p) => {
      const indent = p.parentId ? '  ' : ''
      return `${indent}- ${p.title} [${p.status}] — /${p.slug}`
    })
    .join('\n')

  // Build page content summaries
  const summaries = allPages
    .filter((p) => p.id !== docPageId && p.content)
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

  return {
    projectContext: fullProjectContext.trim() || undefined,
    tableOfContents: toc || undefined,
    credentials: project.credentials ?? undefined,
    customPrompt: page.customPrompt ?? undefined,
    briefing: await enrichBriefingWithFileContents(page.briefing),
    existingPageSummaries: summaries.length > 0 ? summaries : undefined,
  }
}

async function enrichBriefingWithFileContents(
  briefing: import('../page/page.types.js').PageBriefing | null,
): Promise<PageBriefingWithContent | undefined> {
  if (!briefing) return undefined

  const { supabase } = await import('../../shared/db/supabase.client.js')
  const enrichedResources = await Promise.all(
    briefing.resources.map(async (r) => {
      if (r.type !== 'file' || !r.value) return r
      try {
        console.log(`[briefing] Downloading file resource: ${r.value}`)
        const { data, error } = await supabase.storage.from('briefing-files').download(r.value)
        if (error) {
          console.error(`[briefing] Failed to download ${r.value}:`, error.message)
          return r
        }
        if (!data) {
          console.error(`[briefing] No data returned for ${r.value}`)
          return r
        }
        const buffer = Buffer.from(await data.arrayBuffer())
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
    projectContext: undefined,
    tableOfContents: undefined,
    credentials: undefined,
    customPrompt: undefined,
    briefing: undefined,
    existingPageSummaries: undefined,
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

  await exploreRun(id, buildRunDeps(), {
    additionalContext: fullContext,
    projectContext: awareness.projectContext,
    tableOfContents: awareness.tableOfContents,
    credentials: awareness.credentials,
    customPrompt: awareness.customPrompt,
    briefing: awareness.briefing,
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
  let docOptions: { projectContext?: string; tableOfContents?: string; existingPageSummaries?: { title: string; slug: string; contentPreview: string }[] } | undefined
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
    }
  }

  const doc = await generateAndSaveDoc(id, buildDocDeps(), docOptions)

  // FIX 4: page.content is THE source of truth — write synchronously, no silent catch
  if (run.docPageId && doc.markdownContent) {
    const { updatePageContent, findPageById } = await import('../page/page.repository.js')
    await updatePageContent(run.docPageId, doc.markdownContent)

    // Enrich project discovered context
    try {
      const page = await findPageById(run.docPageId)
      if (page) {
        const { findProjectById, updateDiscoveredContext } = await import('../project/project.repository.js')
        const project = await findProjectById(page.projectId)
        if (project) {
          const { buildContextEnrichmentPrompt } = await import('../../shared/ai/prompt.builder.js')
          const { anthropic } = await import('../../shared/ai/anthropic.client.js')
          const prompt = buildContextEnrichmentPrompt(
            project.discoveredContext,
            doc.markdownContent,
            run.featureName,
          )
          const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }],
          })
          const textBlock = response.content.find((b) => b.type === 'text')
          if (textBlock && textBlock.type === 'text') {
            let jsonStr = textBlock.text.trim()
            if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
            const { DiscoveredContextSchema } = await import('../project/project.schema.js')
            const parsed = DiscoveredContextSchema.safeParse(JSON.parse(jsonStr))
            if (parsed.success) {
              await updateDiscoveredContext(project.id, parsed.data)
            } else {
              console.error('Context enrichment validation failed:', parsed.error.flatten())
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to enrich project context:', err)
    }
  }

  return doc
}

export async function cancelExploration(id: string): Promise<void> {
  const run = await runRepo.findRunById(id)
  if (!run) throw new NotFoundError('Run')
  if (run.status !== 'running') throw new NotFoundError('Run is not running')
  const { cancelRun } = await import('../exploration/exploration.service.js')
  cancelRun(id)
}

export async function analyzeVideo(runId: string, videoPath: string): Promise<void> {
  const run = await runRepo.findRunById(runId)
  if (!run) throw new NotFoundError('Run')

  await runRepo.updateRunStatus(runId, 'running')

  try {
    // Download video from Supabase Storage
    const { supabase } = await import('../../shared/db/supabase.client.js')
    const { data, error } = await supabase.storage.from('artifacts').download(videoPath)
    if (error || !data) throw new Error(`Failed to download video: ${error?.message ?? 'no data'}`)

    const buffer = Buffer.from(await data.arrayBuffer())
    const mimeType = videoPath.endsWith('.webm') ? 'video/webm'
      : videoPath.endsWith('.mov') ? 'video/quicktime'
      : 'video/mp4'
    const fileName = videoPath.split('/').pop() ?? 'video.mp4'

    // Analyze with Gemini
    const { analyzeVideoWithGemini } = await import('../../shared/ai/gemini.client.js')
    const analysis = await analyzeVideoWithGemini(buffer, mimeType, fileName)

    // Create RunSteps from analysis
    for (let i = 0; i < analysis.steps.length; i++) {
      const s = analysis.steps[i]!
      const narrationText = s.narration ? `\nNarration: ${s.narration}` : ''
      await runRepo.createRunStep({
        runId,
        stepIndex: i,
        title: s.userAction,
        action: s.userAction,
        observation: `${s.screenDescription}${narrationText}`,
        status: 'completed',
      })
    }

    // Build summary
    await runRepo.updateRunSummary(runId, {
      sections: [{
        url: 'video',
        label: analysis.productName || run.featureName,
        status: 'documented',
        stepCount: analysis.steps.length,
      }],
      blockers: [],
      agentMessage: analysis.summary,
    })

    await runRepo.updateRunStatus(runId, 'completed')
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
