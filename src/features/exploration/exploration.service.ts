import {
  launchBrowser,
  closeBrowser,
  getSessionId,
} from '../../shared/browser/playwright.client.js'
import { STAGEHAND_MODEL } from '../../shared/ai/anthropic.client.js'
import * as explorationBrowser from './exploration.browser.js'
import type { AgentActionRecord, StepEvent, ExplorationSummary, ExplorationBlocker } from './exploration.types.js'
import type { PageBriefingWithContent, PageResourceWithContent } from '../page/page.types.js'

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
        const resourceBlocks = b.resources.map((r) => {
          const res = r as PageResourceWithContent
          if (res.type === 'file' && res.content) {
            const ext = res.value.split('.').pop() ?? ''
            return `### [file] ${res.label}\n\`\`\`${ext}\n${res.content}\n\`\`\``
          }
          return `- [${res.type}] ${res.label}: ${res.value}`
        })
        parts.push(`**Reference materials**:\n${resourceBlocks.join('\n\n')}`)

        // Tell the agent about uploadable files
        const uploadableFiles = b.resources.filter((r) => r.type === 'file' && (r as PageResourceWithContent).fileBuffer)
        if (uploadableFiles.length > 0) {
          parts.push(`**Files available for upload**: ${uploadableFiles.map((f) => f.label || f.value.split('/').pop()).join(', ')}. When you encounter a file upload input in the application, click it — the file will be provided automatically.`)
        }
      }
      briefingBlock = `\n\n## User Briefing (PRIORITY — follow these instructions closely)\n${parts.join('\n\n')}`
      console.log(`[exploration] Briefing injected: objective=${b.objective ? 'yes' : 'no'}, knowledge=${b.knowledge ? 'yes' : 'no'}, resources=${b.resources.length} (files with content: ${b.resources.filter((r) => (r as PageResourceWithContent).content).length})`)
    } else if (options?.customPrompt) {
      briefingBlock = `\n\n## Custom Instructions from User\n${options.customPrompt}`
    }

    const instruction = `You are a documentation agent. Your job is to thoroughly explore a web application feature so we can generate product documentation from your exploration.

Feature: ${run.featureName}
Goal: ${run.goal}
Start URL: ${run.startUrl}
${isResuming ? `\nYou are RESUMING a previous exploration. The browser has been navigated to ${run.startUrl}. Focus on sections you haven't explored yet.` : ''}${briefingBlock}${previousStepsBlock}${projectBlock}${tocBlock}${credentialsBlock}${contextBlock}

Instructions:
- You are now on ${run.startUrl} — start exploring from here
- Click through every section, button, menu, and interactive element you find
- Fill forms with realistic test data when needed
- Scroll to see all content on each page
- Visit all linked pages within the feature
- Be systematic: go through navigation items one by one

BUDGET: You have a maximum of 50 actions. Plan accordingly:
- Prioritize the MOST IMPORTANT sections first
- After ~40 actions, start wrapping up and call done with a summary
- Better to document 5 sections thoroughly than 10 sections poorly
- Each screenshot, scroll, and click counts as one action

CRITICAL RULES FOR STOPPING:
- If you encounter a login page or auth wall and do NOT have credentials, call done IMMEDIATELY. Do not retry. Explain what access is needed.
- If an action fails, try ONE alternative. If that also fails, move on. Do NOT retry more than twice.
- If the page looks empty, broken, or returns an error, call done and explain.
- If you've explored all visible sections, call done. Don't navigate in circles.
- When your goal is achieved, call done. Don't keep exploring unnecessarily.

When to call done:
- You have explored all main sections relevant to the goal
- You've captured the key user flows and interactions
- You're running low on actions (~40+)
- OR you are blocked and cannot proceed further`

    // Make briefing files available for upload via CDP file chooser interception
    const briefingFiles = (options?.briefing?.resources ?? [])
      .filter((r): r is PageResourceWithContent & { fileBuffer: Buffer; fileName: string } =>
        r.type === 'file' && !!(r as PageResourceWithContent).fileBuffer && !!(r as PageResourceWithContent).fileName,
      )

    if (briefingFiles.length > 0) {
      const activePage = session.context.activePage()
      const firstFile = briefingFiles[0]
      if (activePage && firstFile) {
        const base64 = firstFile.fileBuffer.toString('base64')
        await activePage.evaluate(
          ({ b64, name }: { b64: string; name: string }) => {
            // Store file data globally for file input auto-fill
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any
            w.__aidocFile = { b64, name }

            const fillFileInputs = (): void => {
              document.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach((input) => {
                if (input.dataset.aidocFilled) return
                input.dataset.aidocFilled = 'true'
                input.addEventListener('click', (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const stored = w.__aidocFile as { b64: string; name: string }
                  const bytes = Uint8Array.from(atob(stored.b64), (c) => c.charCodeAt(0))
                  const f = new File([bytes], stored.name, { type: 'application/octet-stream' })
                  const dt = new DataTransfer()
                  dt.items.add(f)
                  input.files = dt.files
                  input.dispatchEvent(new Event('change', { bubbles: true }))
                }, { once: true })
              })
            }

            fillFileInputs()
            new MutationObserver(fillFileInputs).observe(document.body, { childList: true, subtree: true })
          },
          { b64: base64, name: firstFile.fileName },
        )
        console.log(`[exploration] File upload helper injected: ${firstFile.fileName} (${firstFile.fileBuffer.length} bytes)`)
      }
    }

    emit({ type: 'status', message: isResuming ? 'Resuming exploration...' : 'Agent is exploring...' })

    const stepOffset = await deps.countSteps(runId)
    let stepCounter = 0

    const agent = session.agent({
      model: {
        modelName: STAGEHAND_MODEL,
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
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

          const agentText = event.text ?? ''

          // FIX 1: Capture the ACTUAL browser URL (not tool arg URL)
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

            // FIX 2: Capture tool result (success/failure) alongside reasoning
            const toolResultStr = toolResult
              ? JSON.stringify(toolResult).slice(0, 2000)
              : ''
            const fullObservation = [
              agentText.slice(0, 4000),
              toolResultStr ? `\n[Tool result: ${toolResultStr}]` : '',
            ].join('')

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
            const isInternalTool = toolName === 'ariaTree' || toolName === 'screenshot' || toolName === 'wait'

            if (!isInternalTool) {
              emit({
                type: 'step',
                step: record,
                stepIndex: stepCounter,
                message: record.action ?? toolName,
              })
            }

            // Stream agent reasoning as a status update (what it's thinking)
            if (agentText && agentText.length > 10) {
              const thinkingPreview = agentText.split('\n')[0]?.slice(0, 150) ?? ''
              if (thinkingPreview) {
                emit({ type: 'status', message: thinkingPreview })
              }
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
    const isCancelled = (err as Error).message === 'Exploration cancelled by user'
    await deps.updateRunStatus(runId, 'failed')
    if (isCancelled) {
      emit({ type: 'cancelled', message: 'Exploration stopped by user' })
    } else {
      console.error(`Exploration failed for run ${runId}:`, err)
      emit({ type: 'error', message: (err as Error).message })
    }
    throw err
  } finally {
    cancelledRuns.delete(runId)
    // Always close browser to avoid Browserbase billing
    // Resume works via step context + navigating back to startUrl
    await closeBrowser(session)
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
