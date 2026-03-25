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

    if (!run.browserbaseSessionId) {
      emit({ type: 'status', message: `Navigating to ${run.startUrl}` })
      await explorationBrowser.navigateTo(session, run.startUrl)
    }

    const contextBlock = options?.additionalContext
      ? `\n\n## Additional Context from User\n${options.additionalContext}`
      : ''

    const isResume = run.browserbaseSessionId !== null
    const resumeBlock = isResume
      ? '\n\nYou are RESUMING a previous exploration. The browser is already open where you left off. Continue from here.'
      : ''

    const instruction = `You are a documentation agent. Explore this web application feature thoroughly.

Feature: ${run.featureName}
Goal: ${run.goal}
Start URL: ${run.startUrl}
${resumeBlock}${contextBlock}

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
        modelName: 'anthropic/claude-sonnet-4-20250514',
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
    })

    const result = await agent.execute({
      instruction,
      maxSteps: 30,
      callbacks: {
        onStepFinish: async (event) => {
          // Each "step" from the AI SDK is one LLM call which may produce multiple tool calls
          const toolCalls = event.toolCalls ?? []

          for (const tool of toolCalls) {
            const toolObj = tool as Record<string, unknown>
            const toolName = (toolObj.toolName ?? 'unknown') as string
            const args = toolObj.args as Record<string, unknown> | undefined

            if (toolName === 'think') continue

            const record: AgentActionRecord = {
              type: toolName,
              action: (args?.instruction ?? args?.action ?? args?.url ?? toolName) as string | null,
              pageUrl: (args?.url as string | undefined) ?? null,
              reasoning: (args?.reasoning as string | undefined) ?? null,
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
