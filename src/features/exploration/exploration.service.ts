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
}

export interface ExploreOptions {
  additionalContext?: string
  projectContext?: string
  tableOfContents?: string
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

  const session = await launchBrowser(run.browserbaseSessionId ?? undefined)

  try {
    const sessionId = getSessionId(session)
    if (sessionId && !run.browserbaseSessionId) {
      await deps.setBrowserbaseSessionId(runId, sessionId)
    }

    // Send live browser view URL to frontend
    const debugUrl = session.browserbaseDebugURL
    if (debugUrl) {
      emit({ type: 'live', liveUrl: debugUrl, message: 'Live browser view available' })
    }

    if (!run.browserbaseSessionId) {
      emit({ type: 'status', message: `Navigating to ${run.startUrl}` })
      await explorationBrowser.navigateTo(session, run.startUrl)
    }

    const contextBlock = options?.additionalContext
      ? `\n\n## Additional Context from User\n${options.additionalContext}`
      : ''

    const projectBlock = options?.projectContext
      ? `\n\n## Product Context\n${options.projectContext}`
      : ''

    const tocBlock = options?.tableOfContents
      ? `\n\n## Already Documented Pages\n${options.tableOfContents}\nDo NOT duplicate content covered in these pages. Reference them when relevant.`
      : ''

    const isResume = run.browserbaseSessionId !== null
    const resumeBlock = isResume
      ? '\n\nYou are RESUMING a previous exploration. The browser is already open where you left off. Continue from here.'
      : ''

    const instruction = `You are a documentation agent. Explore this web application feature thoroughly.

Feature: ${run.featureName}
Goal: ${run.goal}
Start URL: ${run.startUrl}
${projectBlock}${tocBlock}${resumeBlock}${contextBlock}

Instructions:
- Navigate through the feature, clicking buttons, opening menus, filling forms with test data
- Document every screen and interaction you encounter
- If you hit a login wall or auth gate you cannot pass, stop and clearly explain what's needed
- Explore at least 5-10 meaningful interactions before finishing
- When you've explored enough to write comprehensive documentation, finish
- Be thorough but efficient`

    emit({ type: 'status', message: 'Agent is exploring...' })

    let stepOffset = await deps.countSteps(runId)
    let stepCounter = 0

    const agent = session.agent({
      model: {
        modelName: 'anthropic/claude-haiku-4-5-20251001',
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
    })

    const result = await agent.execute({
      instruction,
      maxSteps: 25,
      callbacks: {
        onStepFinish: async (event) => {
          const toolCalls = event.toolCalls ?? []
          const toolResults = event.toolResults ?? []

          // Build a map of tool call results by toolCallId
          const resultMap = new Map<string, unknown>()
          for (const tr of toolResults) {
            const trObj = tr as Record<string, unknown>
            const callId = (trObj.toolCallId ?? '') as string
            if (callId) resultMap.set(callId, trObj.result)
          }

          // Also extract the agent's reasoning text from the response
          const agentText = event.text ?? ''

          for (const tool of toolCalls) {
            const toolObj = tool as Record<string, unknown>
            const toolName = (toolObj.toolName ?? 'unknown') as string
            const toolCallId = (toolObj.toolCallId ?? '') as string
            const args = toolObj.args as Record<string, unknown> | undefined
            const toolResult = resultMap.get(toolCallId) as Record<string, unknown> | undefined

            if (toolName === 'think') continue

            // Build a human-readable description
            const description = buildToolDescription(toolName, args, toolResult)

            const record: AgentActionRecord = {
              type: toolName,
              action: description,
              pageUrl: (args?.url as string | undefined) ?? null,
              reasoning: agentText.slice(0, 500) || null,
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

    // Track token usage
    if (result.usage) {
      await deps.incrementTokenUsage(
        runId,
        result.usage.input_tokens + result.usage.output_tokens,
      )
    }

    // Determine outcome
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
      return
    }

    if (result.completed) {
      await deps.updateRunStatus(runId, 'completed')
      emit({ type: 'done', completed: true, message: result.message })
    } else {
      await deps.updateRunStatus(runId, 'blocked')
      emit({ type: 'blocked', message: result.message })
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
  // Try to find any meaningful text from args
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
      const msg = tryFields(['message', 'reason', 'summary'])
        ?? (typeof toolResult === 'object' && toolResult ? (toolResult.message as string | undefined) : null)
        ?? 'Task complete'
      return `Done: ${msg}`
    }
    default: {
      // Last resort: try all known field names, or stringify args
      const desc = tryFields(['instruction', 'action', 'text', 'description', 'url', 'message'])
      if (desc) return desc
      // If args exist but we couldn't find a good field, show the args keys
      if (args && Object.keys(args).length > 0) {
        const firstVal = Object.values(args).find((v) => typeof v === 'string' && v.length > 0)
        if (typeof firstVal === 'string') return firstVal
      }
      return toolName
    }
  }
}
