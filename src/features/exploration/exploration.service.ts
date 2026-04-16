import {
  launchBrowser,
  closeBrowser,
  getSessionId,
} from '../../shared/browser/playwright.client.js'
import { STAGEHAND_MODEL } from '../../shared/ai/anthropic.client.js'
import * as explorationBrowser from './exploration.browser.js'
import type { AgentActionRecord, StepEvent, ExplorationSummary, ExplorationBlocker } from './exploration.types.js'
import type { PageBriefingWithContent, PageResourceWithContent } from '../page/page.types.js'
import { env } from '../../shared/config/env.js'

// In-memory cancellation signal — same process handles exploration + cancel request
const cancelledRuns = new Set<string>()

export function cancelRun(runId: string): void {
  cancelledRuns.add(runId)
}

export interface RunData {
  startUrl: string
  goal: string
  featureName: string
  browserbaseSessionId: string | null
}

export interface RunDeps {
  findRunById: (id: string) => Promise<(RunData & { status: string }) | null>
  updateRunStatus: (id: string, status: 'pending' | 'running' | 'blocked' | 'completed' | 'failed') => Promise<unknown>
  incrementTokenUsage: (id: string, tokens: number) => Promise<void>
  setBrowserbaseSessionId: (id: string, sessionId: string) => Promise<void>
  createRunStep: (input: {
    runId: string
    stepIndex: number
    url?: string
    title?: string
    action?: string
    observation?: string
    screenshotPath?: string
    status?: 'completed' | 'blocked' | 'skipped'
  }) => Promise<{ id: string }>
  countSteps: (runId: string) => Promise<number>
  findStepsByRunId: (runId: string) => Promise<
    { action: string | null; url: string | null; observation: string | null; status: string }[]
  >
}

export interface ExploreOptions {
  additionalContext?: string
  projectContext?: string
  tableOfContents?: string
  credentials?: { label: string; username: string; password: string }[]
  customPrompt?: string
  briefing?: PageBriefingWithContent
  onEvent?: (event: StepEvent) => void
}

export async function exploreRun(
  runId: string,
  deps: RunDeps,
  options?: ExploreOptions,
): Promise<void> {
  const run = await deps.findRunById(runId)
  if (!run) throw new Error(`Run ${runId} not found`)

  const emit = options?.onEvent ?? (() => {})

  await deps.updateRunStatus(runId, 'running')
  emit({ type: 'status', message: 'Launching browser...' })

  const isResuming = run.browserbaseSessionId !== null
  const session = await launchBrowser(run.browserbaseSessionId ?? undefined)

  try {
    const sessionId = getSessionId(session)
    if (sessionId && !run.browserbaseSessionId) {
      await deps.setBrowserbaseSessionId(runId, sessionId)
    }

    const debugUrl = session.browserbaseDebugURL
    if (debugUrl) {
      emit({ type: 'live', liveUrl: debugUrl, message: 'Live browser view available' })
    }

    // Always navigate to startUrl — even on resume, ensure we're on the right page
    emit({ type: 'status', message: `Navigating to ${run.startUrl}` })
    await explorationBrowser.navigateTo(session, run.startUrl)

    // Build context from existing steps (for resume)
    const existingSteps = await deps.findStepsByRunId(runId)
    let previousStepsBlock = ''
    if (existingSteps.length > 0) {
      // Group steps by URL to show coverage
      const urlMap = new Map<string, string[]>()
      for (const s of existingSteps) {
        const url = s.url ?? 'unknown'
        if (!urlMap.has(url)) urlMap.set(url, [])
        urlMap.get(url)!.push(s.action ?? 'action')
      }
      const coverage = Array.from(urlMap.entries())
        .map(([url, actions]) => `- ${url}: ${actions.length} steps (${actions.slice(0, 3).join(', ')}${actions.length > 3 ? '...' : ''})`)
        .join('\n')

      previousStepsBlock = `\n\n## Pages Already Explored (${existingSteps.length} steps total)
${coverage}

You are RESUMING. Continue exploring sections you haven't covered yet. Do NOT revisit pages listed above unless necessary.`
    }

    const contextBlock = options?.additionalContext
      ? `\n\n## Additional Context from User\n${options.additionalContext}`
      : ''

    const projectBlock = options?.projectContext
      ? `\n\n## Product Context\n${options.projectContext}`
      : ''

    const tocBlock = options?.tableOfContents
      ? `\n\n## Already Documented Pages\n${options.tableOfContents}\nDo NOT duplicate content covered in these pages.`
      : ''

    const creds = options?.credentials ?? []
    const credentialsBlock = creds.length > 0
      ? `\n\n## Test Credentials Available
${creds.map((c) => `- ${c.label}: username=%${c.label}_username%, password=%${c.label}_password%`).join('\n')}
Use these credentials to log in when you encounter a login page. The values are injected via variables — just use the %variable% syntax in form fields.`
      : ''

    // Build Stagehand variables from credentials
    const variables: Record<string, { value: string; description: string }> = {}
    for (const c of creds) {
      variables[`${c.label}_username`] = { value: c.username, description: `Username for ${c.label}` }
      variables[`${c.label}_password`] = { value: c.password, description: `Password for ${c.label}` }
    }

    let briefingBlock = ''
    if (options?.briefing) {
      const b = options.briefing
      const parts: string[] = []
      if (b.objective) parts.push(`**YOUR OBJECTIVE**: ${b.objective}`)
      if (b.knowledge) parts.push(`**IMPORTANT CONTEXT — read carefully before exploring**:\n${b.knowledge}`)
      if (b.resources.length > 0) {
        // Separate uploadable files (shown as upload instructions) from other resources (shown as context)
        const uploadable: string[] = []
        const contextBlocks: string[] = []

        for (const r of b.resources) {
          const res = r as PageResourceWithContent
          if (res.type === 'file' && res.fileBuffer) {
            // File is for upload only — don't dump content into prompt
            uploadable.push(res.label || res.value.split('/').pop() || 'file')
          } else {
            contextBlocks.push(`- [${res.type}] ${res.label}: ${res.value}`)
          }
        }

        if (contextBlocks.length > 0) {
          parts.push(`**Reference materials**:\n${contextBlocks.join('\n')}`)
        }
        if (uploadable.length > 0) {
          parts.push(`**Files available for upload**: ${uploadable.join(', ')}. The file is pre-loaded into file inputs automatically. When you see a file upload area, look for the file input and interact with it — the file should already be attached. If the upload shows a filename or progress, it worked. Move on to the next step.`)
        }
      }
      briefingBlock = `\n\n## User Briefing (PRIORITY — follow these instructions closely)\n${parts.join('\n\n')}`
      console.log(`[exploration] Briefing injected: objective=${b.objective ? 'yes' : 'no'}, knowledge=${b.knowledge ? 'yes' : 'no'}, resources=${b.resources.length} (files with content: ${b.resources.filter((r) => (r as PageResourceWithContent).content).length})`)
    } else if (options?.customPrompt) {
      briefingBlock = `\n\n## Custom Instructions from User\n${options.customPrompt}`
    }

    const instruction = `Documentation agent — explore a web app to generate product docs.

Feature: ${run.featureName}
Goal: ${run.goal}
Start: ${run.startUrl}${isResuming ? ' (RESUMING — skip already-covered sections)' : ''}
${briefingBlock}${previousStepsBlock}${projectBlock}${tocBlock}${credentialsBlock}${contextBlock}

Rules:
- Explore systematically: navigate sections, click buttons, fill forms with test data
- Budget: 50 actions max. Prioritize the most important sections. Wrap up at ~40.
- Login wall without credentials → call done immediately
- Action fails twice → move on
- Stuck on same page for 3+ actions → call done immediately. Do NOT overthink or retry endlessly.
- Cannot proceed (error, blocker, confusion) → call done. You are a naive user — if you're lost, just stop.
- All sections explored → call done`

    // Upload files to Browserbase cloud session, then auto-fill file inputs via setInputFiles
    // Per Browserbase docs: upload via REST API → file at /tmp/.uploads/{name} in cloud browser
    // → use setInputFiles with that path (works because path resolves in cloud browser)
    const briefingFiles = (options?.briefing?.resources ?? [])
      .filter((r): r is PageResourceWithContent & { fileBuffer: Buffer; fileName: string } =>
        r.type === 'file' && !!(r as PageResourceWithContent).fileBuffer && !!(r as PageResourceWithContent).fileName,
      )

    let uploadedFilePath: string | null = null

    if (briefingFiles.length > 0) {
      const sessionId = session.browserbaseSessionID
      if (sessionId) {
        try {
          const firstFile = briefingFiles[0]!

          // Upload file to Browserbase cloud session via REST API
          const formData = new FormData()
          formData.append('file', new Blob([firstFile.fileBuffer]), firstFile.fileName)
          const uploadRes = await fetch(
            `https://api.browserbase.com/v1/sessions/${sessionId}/uploads`,
            {
              method: 'POST',
              headers: { 'x-bb-api-key': env.BROWSERBASE_API_KEY },
              body: formData,
            },
          )
          if (!uploadRes.ok) {
            console.error(`[exploration] Browserbase upload failed: ${uploadRes.status} ${await uploadRes.text()}`)
          } else {
            uploadedFilePath = `/tmp/.uploads/${firstFile.fileName}`
            console.log(`[exploration] File uploaded to Browserbase session: ${firstFile.fileName} → ${uploadedFilePath}`)
          }
        } catch (err) {
          console.warn(`[exploration] Browserbase file upload failed:`, err)
        }
      }
    }

    emit({ type: 'status', message: isResuming ? 'Resuming exploration...' : 'Agent is exploring...' })

    const stepOffset = await deps.countSteps(runId)
    let stepCounter = 0

    const agent = session.agent({
      model: {
        modelName: STAGEHAND_MODEL,
        apiKey: process.env.GEMINI_API_KEY,
      },
      mode: 'hybrid',
    })

    const result = await agent.execute({
      instruction,
      maxSteps: 50,
      ...(Object.keys(variables).length > 0 ? { variables } : {}),
      callbacks: {
        onStepFinish: async (event) => {
          // Check cancellation signal before processing
          if (cancelledRuns.has(runId)) {
            cancelledRuns.delete(runId)
            throw new Error('Exploration cancelled by user')
          }

          const toolCalls = event.toolCalls ?? []
          const toolResults = event.toolResults ?? []

          const resultMap = new Map<string, unknown>()
          for (const tr of toolResults) {
            const trObj = tr as Record<string, unknown>
            const callId = (trObj.toolCallId ?? '') as string
            if (callId) resultMap.set(callId, trObj.result)
          }

          // Extract agent reasoning — try multiple fields (Gemini vs Claude structure)
          const eventObj = event as Record<string, unknown>
          const agentText = (event.text ?? eventObj.reasoning ?? eventObj.thought ?? eventObj.message ?? '') as string

          // Debug: log event keys for first few steps to understand Gemini's output shape
          if (!agentText && stepCounter < 3) {
            console.log(`[exploration] Step ${stepCounter} event keys (no reasoning text):`, Object.keys(eventObj).join(', '))
          }

          // Auto-fill file inputs after each step (if file was uploaded to Browserbase)
          if (uploadedFilePath) {
            try {
              const page = session.context.activePage()
              if (page) {
                const fileInputs = await page.locator('input[type="file"]').all()
                for (const input of fileInputs) {
                  const filled = await input.getAttribute('data-aidoc-filled').catch(() => null)
                  if (!filled) {
                    await input.setInputFiles(uploadedFilePath)
                    await input.evaluate((el: HTMLInputElement) => { el.dataset.aidocFilled = 'true' })
                    console.log(`[exploration] File injected into input via setInputFiles: ${uploadedFilePath}`)
                  }
                }
              }
            } catch {
              // Page navigated or input gone — ignore
            }
          }

          // Capture the ACTUAL browser URL (not tool arg URL)
          const activePage = session.context.activePage()
          const currentUrl = activePage ? activePage.url() : run.startUrl

          for (const tool of toolCalls) {
            const toolObj = tool as Record<string, unknown>
            const toolName = (toolObj.toolName ?? 'unknown') as string
            const toolCallId = (toolObj.toolCallId ?? '') as string
            const args = toolObj.args as Record<string, unknown> | undefined
            const toolResult = resultMap.get(toolCallId) as Record<string, unknown> | undefined

            if (toolName === 'think') continue

            const description = buildToolDescription(toolName, args, toolResult)

            // Build rich observation from ALL available data — Gemini often has
            // empty reasoning but args contain the instruction/intent
            const observationParts: string[] = []
            if (agentText) observationParts.push(agentText.slice(0, 4000))
            // Include tool args as intent (critical for Gemini which may not provide reasoning)
            if (args) {
              const argsStr = Object.entries(args)
                .filter(([, v]) => typeof v === 'string' && (v as string).length > 0)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ')
              if (argsStr) observationParts.push(`[Intent: ${argsStr}]`)
            }
            const toolResultStr = toolResult
              ? JSON.stringify(toolResult).slice(0, 2000)
              : ''
            if (toolResultStr) observationParts.push(`[Result: ${toolResultStr}]`)
            const fullObservation = observationParts.join('\n') || description

            const record: AgentActionRecord = {
              type: toolName,
              action: description,
              pageUrl: currentUrl,
              reasoning: fullObservation || null,
            }

            const screenshotPath = await explorationBrowser.captureScreenshot(
              session,
              runId,
              stepOffset + stepCounter,
            )

            // Derive step status from tool result
            const stepStatus = deriveStepStatus(toolResult)

            await deps.createRunStep({
              runId,
              stepIndex: stepOffset + stepCounter,
              url: currentUrl,
              title: description,
              action: record.action ?? toolName,
              observation: fullObservation.slice(0, 8000),
              screenshotPath: screenshotPath ?? undefined,
              status: stepStatus,
            })

            // Stream the agent's thinking, not just tool names
            // Skip noisy internal tools from the live feed
            const isInternalTool = toolName === 'ariaTree' || toolName === 'screenshot' || toolName === 'wait' || toolName === 'scroll' || toolName === 'keys'

            if (!isInternalTool) {
              // Build a richer message: action + reasoning if available
              const stepMsg = agentText && agentText.length > 10
                ? `${record.action ?? toolName} — ${agentText.slice(0, 200)}`
                : record.action ?? toolName
              emit({
                type: 'step',
                step: record,
                stepIndex: stepCounter,
                message: stepMsg,
              })
            } else if (agentText && agentText.length > 10) {
              // Even for internal tools, stream the reasoning so user sees progress
              emit({ type: 'status', message: agentText.slice(0, 500) })
            }

            stepCounter++
          }
        },
      },
    })

    if (result.usage) {
      await deps.incrementTokenUsage(
        runId,
        result.usage.input_tokens + result.usage.output_tokens,
      )
    }

    // Build structured summary from steps + agent message
    const allSteps = await deps.findStepsByRunId(runId)
    const summary = buildExplorationSummary(allSteps, result.message, result.completed)

    // Detect step limit hit (not blocked, just ran out of steps)
    const hitStepLimit = !result.completed && summary.blockers.length === 0
    if (hitStepLimit) {
      summary.blockers.push({
        type: 'other',
        description: `Reached the 50-step exploration limit. The agent explored ${allSteps.length} actions but hasn't finished documenting all sections.`,
        section: 'Exploration budget',
        actionLabel: 'Continue exploring remaining sections',
      })
    }

    // Emit summary event (persisted by run.service)
    emit({ type: 'summary', summary })

    if (!result.completed && summary.blockers.length > 0) {
      await deps.updateRunStatus(runId, 'blocked')
      emit({ type: 'blocked', message: result.message })
    } else if (result.completed) {
      await deps.updateRunStatus(runId, 'completed')
      emit({ type: 'done', completed: true, message: result.message })
    } else {
      await deps.updateRunStatus(runId, 'blocked')
      emit({ type: 'blocked', message: result.message || 'Agent stopped — you can continue the exploration' })
    }
  } catch (err) {
    const msg = (err as Error).message
    const isCancelled = msg === 'Exploration cancelled by user'
    await deps.updateRunStatus(runId, 'failed')
    if (isCancelled) {
      emit({ type: 'cancelled', message: 'Exploration stopped by user' })
    } else {
      console.error(`Exploration failed for run ${runId}:`, err)
      emit({ type: 'error', message: msg })
    }
    throw err
  } finally {
    cancelledRuns.delete(runId)
    // Always close browser to avoid Browserbase billing
    await closeBrowser(session)

    // Download session recording from Browserbase and store in Supabase
    const bbSessionId = getSessionId(session)
    if (bbSessionId) {
      saveSessionRecording(runId, bbSessionId).catch((err) =>
        console.error(`[recording] Failed to save recording for run ${runId}:`, err),
      )
    }
  }
}

function deriveStepStatus(toolResult: Record<string, unknown> | undefined): 'completed' | 'blocked' | 'skipped' {
  if (!toolResult) return 'completed'
  if (toolResult.error || toolResult.errorMessage || toolResult.failed === true) return 'blocked'
  if (typeof toolResult.success === 'boolean' && !toolResult.success) return 'blocked'
  return 'completed'
}

function extractPathname(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function pathToLabel(path: string): string {
  if (path === '/') return 'Homepage'
  return path
    .replace(/^\//, '')
    .split('/')
    .map((segment) => segment.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()))
    .join(' > ')
}

function buildExplorationSummary(
  steps: { action: string | null; url: string | null; observation: string | null; status: string }[],
  agentMessage: string,
  completed: boolean,
): ExplorationSummary {
  // FIX 3: Group by URL pathname with error detection from tool results
  const sectionMap = new Map<string, {
    steps: number
    hasErrors: boolean
    lastAction: string
    urls: Set<string>
  }>()

  for (const s of steps) {
    const path = extractPathname(s.url ?? '/')
    const existing = sectionMap.get(path) ?? { steps: 0, hasErrors: false, lastAction: '', urls: new Set() }
    existing.steps++
    existing.urls.add(s.url ?? '/')
    existing.lastAction = s.action ?? ''

    // Detect errors from step status (set by deriveStepStatus from tool results)
    if (s.status === 'blocked') {
      existing.hasErrors = true
    }

    sectionMap.set(path, existing)
  }

  // Build sections with real status based on data
  const sections = Array.from(sectionMap.entries()).map(([path, data]) => ({
    url: path,
    label: pathToLabel(path),
    status: (data.hasErrors ? 'blocked' : completed ? 'documented' : 'partial') as 'documented' | 'partial' | 'blocked' | 'skipped',
    stepCount: data.steps,
  }))

  // Build blockers from: 1) failed sections 2) agent message classification
  const blockers: ExplorationBlocker[] = []

  // Blockers from sections with errors
  for (const section of sections) {
    if (section.status === 'blocked') {
      blockers.push({
        type: 'error',
        description: `Encountered errors while exploring ${section.label}`,
        section: section.label,
        actionLabel: `Retry exploring ${section.label}`,
      })
    }
  }

  // Blockers from agent's final message (if not completed)
  if (!completed && blockers.length === 0) {
    const msg = agentMessage.toLowerCase()
    if (msg.includes('login') || msg.includes('credential') || msg.includes('password') || msg.includes('sign in') || msg.includes('authenticat')) {
      blockers.push({
        type: 'credentials',
        description: agentMessage.slice(0, 300),
        section: 'Authentication',
        actionLabel: 'Provide login credentials',
      })
    } else if (msg.includes('403') || msg.includes('forbidden') || msg.includes('access denied')) {
      blockers.push({
        type: 'access',
        description: agentMessage.slice(0, 300),
        section: 'Access restricted',
        actionLabel: 'Provide access details',
      })
    } else if (agentMessage.trim()) {
      blockers.push({
        type: 'other',
        description: agentMessage.slice(0, 300),
        section: 'Exploration',
        actionLabel: 'Provide guidance',
      })
    }
  }

  return { sections, blockers, agentMessage: agentMessage.slice(0, 500) }
}

function buildToolDescription(
  toolName: string,
  args: Record<string, unknown> | undefined,
  toolResult: Record<string, unknown> | undefined,
): string {
  const tryFields = (fields: string[]): string | null => {
    if (!args) return null
    for (const f of fields) {
      const val = args[f]
      if (typeof val === 'string' && val.length > 0) return val
    }
    return null
  }

  switch (toolName) {
    case 'act':
      return tryFields(['instruction', 'action', 'text', 'description']) ?? 'Performing action'
    case 'goto':
      return `Navigate to ${tryFields(['url']) ?? 'page'}`
    case 'extract':
      return `Extract: ${tryFields(['instruction', 'description']) ?? 'page content'}`
    case 'scroll':
      return `Scroll ${tryFields(['direction']) ?? 'down'}`
    case 'screenshot':
      return 'Capture screenshot'
    case 'fillForm':
      return `Fill form: ${tryFields(['instruction', 'description']) ?? 'form fields'}`
    case 'ariaTree':
      return 'Analyze page structure'
    case 'keys':
      return `Press keys: ${tryFields(['keys', 'key', 'text']) ?? ''}`
    case 'navback':
      return 'Navigate back'
    case 'wait':
      return `Wait ${args?.ms ?? args?.timeout ?? ''}ms`
    case 'done': {
      const doneMsg = tryFields(['message', 'reason', 'summary'])
        ?? (typeof toolResult === 'object' && toolResult ? (toolResult.message as string | undefined) : null)
        ?? 'Task complete'
      return `Done: ${doneMsg}`
    }
    default: {
      const desc = tryFields(['instruction', 'action', 'text', 'description', 'url', 'message'])
      if (desc) return desc
      if (args && Object.keys(args).length > 0) {
        const firstVal = Object.values(args).find((v) => typeof v === 'string' && v.length > 0)
        if (typeof firstVal === 'string') return firstVal
      }
      return toolName
    }
  }
}

async function saveSessionRecording(runId: string, browserbaseSessionId: string): Promise<void> {
  const { env } = await import('../../shared/config/env.js')
  const { uploadToStorage } = await import('../../shared/db/storage.repository.js')

  console.log(`[recording] Downloading recording for session ${browserbaseSessionId}`)

  // Fetch recording from Browserbase API
  const response = await fetch(
    `https://api.browserbase.com/v1/sessions/${browserbaseSessionId}/recording`,
    { headers: { 'x-bb-api-key': env.BROWSERBASE_API_KEY } },
  )

  if (!response.ok) {
    console.error(`[recording] Browserbase API returned ${response.status}`)
    return
  }

  const recording = await response.json() as unknown[]
  const json = JSON.stringify(recording)
  const buffer = Buffer.from(json, 'utf-8')

  console.log(`[recording] Recording size: ${(buffer.length / 1024).toFixed(0)}KB (${recording.length} events)`)

  const path = `runs/${runId}/recording.json`
  await uploadToStorage('artifacts', path, buffer, 'application/json')

  console.log(`[recording] Saved to ${path}`)
}
