import {
  launchBrowser,
  closeBrowser,
  getSessionId,
} from '../../shared/browser/playwright.client.js'
import * as explorationBrowser from './exploration.browser.js'
import type { ExplorationResult, AgentActionRecord } from './exploration.types.js'

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
}

export async function exploreRun(
  runId: string,
  deps: RunDeps,
  options?: ExploreOptions,
): Promise<ExplorationResult> {
  const run = await deps.findRunById(runId)
  if (!run) throw new Error(`Run ${runId} not found`)

  await deps.updateRunStatus(runId, 'running')

  // Reconnect to existing session if available, otherwise create new
  const session = await launchBrowser(run.browserbaseSessionId ?? undefined)

  try {
    // Save session ID on first launch
    const sessionId = getSessionId(session)
    if (sessionId && !run.browserbaseSessionId) {
      await deps.setBrowserbaseSessionId(runId, sessionId)
    }

    // Only navigate on first exploration (no existing session)
    if (!run.browserbaseSessionId) {
      await explorationBrowser.navigateTo(session, run.startUrl)
    }

    // Build the instruction
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

    // Use Stagehand agent
    const agent = session.agent({
      model: {
        modelName: 'anthropic/claude-sonnet-4-20250514',
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
    })

    const result = await agent.execute({
      instruction,
      maxSteps: 30,
    })

    // Save actions as steps
    const stepOffset = await deps.countSteps(runId)
    const actions: AgentActionRecord[] = []

    for (let i = 0; i < result.actions.length; i++) {
      const action = result.actions[i]
      if (!action) continue

      const record: AgentActionRecord = {
        type: action.type,
        action: action.action ?? action.instruction ?? null,
        pageUrl: action.pageUrl ?? null,
        reasoning: action.reasoning ?? null,
      }
      actions.push(record)

      if (action.type !== 'think') {
        const screenshotPath = await explorationBrowser.captureScreenshot(
          session,
          runId,
          stepOffset + i,
        )
        await deps.createRunStep({
          runId,
          stepIndex: stepOffset + i,
          url: action.pageUrl ?? run.startUrl,
          title: action.type,
          action: record.action ?? action.type,
          observation: record.reasoning?.slice(0, 500) ?? '',
          screenshotPath,
        })
      }
    }

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
      return {
        completed: false,
        message: result.message,
        actions,
        needsQuestion: true,
        question: result.message,
      }
    }

    if (result.completed) {
      await deps.updateRunStatus(runId, 'completed')
    } else {
      // Not blocked, not completed — partial exploration
      // Keep as running so user can retry
      await deps.updateRunStatus(runId, 'blocked')
    }

    return {
      completed: result.completed,
      message: result.message,
      actions,
      needsQuestion: !result.completed,
      question: !result.completed ? `Agent stopped: "${result.message}". Want to provide more guidance?` : null,
    }
  } catch (err) {
    console.error(`Exploration failed for run ${runId}:`, err)
    await deps.updateRunStatus(runId, 'failed')
    throw err
  } finally {
    await closeBrowser(session)
  }
}
