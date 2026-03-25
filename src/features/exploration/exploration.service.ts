import {
  launchBrowser,
  closeBrowser,
  getSessionId,
} from '../../shared/browser/playwright.client.js'
import * as explorationBrowser from './exploration.browser.js'
import type { AgentActionRecord, StepEvent } from './exploration.types.js'

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

    if (!isResuming) {
      emit({ type: 'status', message: `Navigating to ${run.startUrl}` })
      await explorationBrowser.navigateTo(session, run.startUrl)
    }

    // Build context from existing steps (for resume)
    const existingSteps = await deps.findStepsByRunId(runId)
    const previousStepsBlock = existingSteps.length > 0
      ? `\n\n## What You Already Explored (${existingSteps.length} steps)
${existingSteps.map((s, i) => `${i + 1}. [${s.url ?? 'unknown'}] ${s.action ?? 'action'}`).join('\n')}
\nContinue from where you left off. Do NOT repeat these steps.`
      : ''

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

    const instruction = `You are a documentation agent. Your job is to thoroughly explore a web application feature so we can generate product documentation from your exploration.

Feature: ${run.featureName}
Goal: ${run.goal}
Start URL: ${run.startUrl}
${isResuming ? '\nYou are RESUMING a previous exploration. The browser is still open where you left off.' : ''}${previousStepsBlock}${projectBlock}${tocBlock}${credentialsBlock}${contextBlock}

Instructions:
- Click through every section, button, menu, and interactive element you find
- Fill forms with realistic test data when needed
- Scroll to see all content on each page
- Visit all linked pages within the feature
- If you hit a login/auth wall, STOP and explain what credentials are needed
- When you have thoroughly explored ALL aspects of the feature, call done
- Do NOT stop early — explore every screen and sub-section
- Be systematic: go through navigation items one by one

IMPORTANT: Only call "done" when you have genuinely explored everything relevant. A thorough exploration typically involves 15-40 meaningful actions.`

    emit({ type: 'status', message: isResuming ? 'Resuming exploration...' : 'Agent is exploring...' })

    const stepOffset = await deps.countSteps(runId)
    let stepCounter = 0

    const agent = session.agent({
      model: {
        modelName: 'anthropic/claude-haiku-4-5-20251001',
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
    })

    // Timeout after 4 minutes to prevent infinite loops
    const abortController = new AbortController()
    const timeout = setTimeout(() => {
      abortController.abort()
      emit({ type: 'status', message: 'Exploration timed out (4 min limit)' })
    }, 4 * 60 * 1000)

    let result: Awaited<ReturnType<typeof agent.execute>>
    try {
      result = await agent.execute({
        instruction,
        maxSteps: 50,
        signal: abortController.signal,
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
              reasoning: agentText.slice(0, 2000) || null,
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
              title: toolName,
              action: record.action ?? toolName,
              observation: record.reasoning?.slice(0, 2000) ?? '',
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
    } catch (agentErr) {
      // Agent was aborted or errored — still process what we have
      clearTimeout(timeout)
      const isAbort = (agentErr as Error).name === 'AbortError' ||
        (agentErr as Error).message?.includes('abort')
      if (!isAbort) throw agentErr

      await deps.updateRunStatus(runId, 'blocked')
      emit({ type: 'blocked', message: 'Exploration timed out — partial results saved' })
      return
    } finally {
      clearTimeout(timeout)
    }

    if (result.usage) {
      await deps.incrementTokenUsage(
        runId,
        result.usage.input_tokens + result.usage.output_tokens,
      )
    }

    const msg = result.message.toLowerCase()
    const isBlocked = !result.completed && (
      msg.includes('login') ||
      msg.includes('credential') ||
      msg.includes('password') ||
      msg.includes('sign in') ||
      msg.includes('authenticat') ||
      msg.includes('cannot') ||
      msg.includes('unable') ||
      msg.includes('blocked') ||
      msg.includes('access denied')
    )

    if (isBlocked) {
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
    await closeBrowser(session)
  }
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
