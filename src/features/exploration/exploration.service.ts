import {
  launchBrowser,
  closeBrowser,
  getSessionId,
} from '../../shared/browser/playwright.client.js'
import * as explorationBrowser from './exploration.browser.js'
import type { AgentActionRecord, StepEvent, ExplorationSummary, ExplorationBlocker } from './exploration.types.js'

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
    { action: string | null; url: string | null; observation: string | null }[]
  >
}

export interface ExploreOptions {
  additionalContext?: string
  projectContext?: string
  tableOfContents?: string
  credentials?: { label: string; username: string; password: string }[]
  customPrompt?: string
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

    const customPromptBlock = options?.customPrompt
      ? `\n\n## Custom Instructions from User\n${options.customPrompt}`
      : ''

    const instruction = `You are a documentation agent. Your job is to thoroughly explore a web application feature so we can generate product documentation from your exploration.

Feature: ${run.featureName}
Goal: ${run.goal}
Start URL: ${run.startUrl}
${isResuming ? `\nYou are RESUMING a previous exploration. The browser has been navigated to ${run.startUrl}. Focus on sections you haven't explored yet.` : ''}${previousStepsBlock}${projectBlock}${tocBlock}${credentialsBlock}${contextBlock}${customPromptBlock}

Instructions:
- You are now on ${run.startUrl} — start exploring from here
- Click through every section, button, menu, and interactive element you find
- Fill forms with realistic test data when needed
- Scroll to see all content on each page
- Visit all linked pages within the feature
- Be systematic: go through navigation items one by one

CRITICAL RULES FOR STOPPING:
- If you encounter a login page or auth wall and do NOT have credentials, call done IMMEDIATELY. Do not retry. Explain what access is needed.
- If an action fails (button doesn't work, page errors, element not found), try ONE alternative. If that also fails, move on to the next thing. Do NOT retry the same action more than twice.
- If the page looks empty, broken, or returns an error code, call done and explain what happened.
- If you've explored all visible sections and pages, call done. Don't navigate in circles.

When to call done:
- You have explored all main sections and sub-sections
- You've captured the key user flows and interactions
- OR you are blocked and cannot proceed further`

    emit({ type: 'status', message: isResuming ? 'Resuming exploration...' : 'Agent is exploring...' })

    const stepOffset = await deps.countSteps(runId)
    let stepCounter = 0

    const agent = session.agent({
      model: {
        modelName: 'anthropic/claude-haiku-4-5-20251001',
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
    })

    const result = await agent.execute({
      instruction,
      maxSteps: 50,
      ...(Object.keys(variables).length > 0 ? { variables } : {}),
      callbacks: {
        onStepFinish: async (event) => {
          const toolCalls = event.toolCalls ?? []
          const toolResults = event.toolResults ?? []

          const resultMap = new Map<string, unknown>()
          for (const tr of toolResults) {
            const trObj = tr as Record<string, unknown>
            const callId = (trObj.toolCallId ?? '') as string
            if (callId) resultMap.set(callId, trObj.result)
          }

          const agentText = event.text ?? ''

          for (const tool of toolCalls) {
            const toolObj = tool as Record<string, unknown>
            const toolName = (toolObj.toolName ?? 'unknown') as string
            const toolCallId = (toolObj.toolCallId ?? '') as string
            const args = toolObj.args as Record<string, unknown> | undefined
            const toolResult = resultMap.get(toolCallId) as Record<string, unknown> | undefined

            if (toolName === 'think') continue

            const description = buildToolDescription(toolName, args, toolResult)

            const record: AgentActionRecord = {
              type: toolName,
              action: description,
              pageUrl: (args?.url as string | undefined) ?? null,
              reasoning: agentText.slice(0, 8000) || null,
            }

            const screenshotPath = await explorationBrowser.captureScreenshot(
              session,
              runId,
              stepOffset + stepCounter,
            )

            await deps.createRunStep({
              runId,
              stepIndex: stepOffset + stepCounter,
              url: record.pageUrl ?? run.startUrl,
              title: description,
              action: record.action ?? toolName,
              observation: record.reasoning?.slice(0, 8000) ?? '',
              screenshotPath,
            })

            emit({
              type: 'step',
              step: record,
              stepIndex: stepCounter,
              message: record.action ?? toolName,
            })

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
    console.error(`Exploration failed for run ${runId}:`, err)
    await deps.updateRunStatus(runId, 'failed')
    emit({ type: 'error', message: (err as Error).message })
    throw err
  } finally {
    // Always close browser to avoid Browserbase billing
    // Resume works via step context + navigating back to startUrl
    await closeBrowser(session)
  }
}

function buildExplorationSummary(
  steps: { action: string | null; url: string | null; observation: string | null }[],
  agentMessage: string,
  completed: boolean,
): ExplorationSummary {
  // Group steps by URL path to identify sections
  const urlMap = new Map<string, number>()
  for (const s of steps) {
    const url = s.url ?? 'unknown'
    try {
      const path = new URL(url).pathname
      urlMap.set(path, (urlMap.get(path) ?? 0) + 1)
    } catch {
      urlMap.set(url, (urlMap.get(url) ?? 0) + 1)
    }
  }

  const sections = Array.from(urlMap.entries()).map(([url, count]) => ({
    url,
    label: url === '/' ? 'Homepage' : url.replace(/^\//, '').replace(/-/g, ' ').replace(/\//g, ' > '),
    status: completed ? 'documented' as const : 'partial' as const,
    stepCount: count,
  }))

  // Classify blockers from agent message
  const blockers: ExplorationBlocker[] = []
  const msg = agentMessage.toLowerCase()

  if (!completed) {
    if (msg.includes('login') || msg.includes('credential') || msg.includes('password') || msg.includes('sign in') || msg.includes('authenticat')) {
      blockers.push({
        type: 'credentials',
        description: agentMessage,
        section: 'Authentication',
        actionLabel: 'Provide login credentials',
      })
    } else if (msg.includes('403') || msg.includes('forbidden') || msg.includes('access denied') || msg.includes('permission')) {
      blockers.push({
        type: 'access',
        description: agentMessage,
        section: 'Access restricted',
        actionLabel: 'Provide access details',
      })
    } else if (msg.includes('error') || msg.includes('500') || msg.includes('broken') || msg.includes('crash')) {
      blockers.push({
        type: 'error',
        description: agentMessage,
        section: 'Error encountered',
        actionLabel: 'Report issue',
      })
    } else if (agentMessage.trim()) {
      blockers.push({
        type: 'other',
        description: agentMessage,
        section: 'Exploration',
        actionLabel: 'Provide guidance',
      })
    }
  }

  return { sections, blockers, agentMessage }
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
