import {
  launchBrowser,
  closeBrowser,
  getSessionId,
} from '../../shared/browser/playwright.client.js'
import * as explorationBrowser from './exploration.browser.js'
import { getNextDecision } from './exploration.agent.js'
import type { StepSummary, Question, AgentDecision } from './exploration.types.js'

export interface RunDeps {
  findRunById: (id: string) => Promise<{
    startUrl: string
    goal: string
    featureName: string
    browserbaseSessionId: string | null
    status: string
  } | null>
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
  findStepsByRunId: (runId: string) => Promise<{ url: string | null; action: string | null; observation: string | null }[]>
  findQuestionsByRunId: (runId: string) => Promise<{ question: string; answer: string | null }[]>
  createQuestion: (input: { runId: string; stepId: string; question: string }) => Promise<unknown>
}

export interface StepResult {
  done: boolean
  status: 'running' | 'blocked' | 'completed' | 'failed'
  decision: AgentDecision | null
  stepIndex: number
}

export async function executeOneStep(runId: string, deps: RunDeps): Promise<StepResult> {
  const run = await deps.findRunById(runId)
  if (!run) throw new Error(`Run ${runId} not found`)

  // First step: set status to running
  if (run.status === 'pending') {
    await deps.updateRunStatus(runId, 'running')
  }

  // Launch or reconnect browser
  const session = await launchBrowser(run.browserbaseSessionId ?? undefined)

  try {
    // Save the session ID if this is a new session
    const sessionId = getSessionId(session)
    if (sessionId && !run.browserbaseSessionId) {
      await deps.setBrowserbaseSessionId(runId, sessionId)
    }

    // Get existing steps to know where we are
    const existingSteps = await deps.findStepsByRunId(runId)
    const stepIndex = existingSteps.length

    // If first step, navigate to start URL
    if (stepIndex === 0) {
      await explorationBrowser.navigateTo(session, run.startUrl)
    }

    // Build step history from DB
    const stepHistory: StepSummary[] = existingSteps.map((s) => ({
      url: s.url ?? '',
      action: s.action ?? '',
      observation: s.observation ?? '',
    }))

    // Get current page context
    const { url, title, pageContent } = await explorationBrowser.getPageContext(session)

    // Get questions
    const questions = await deps.findQuestionsByRunId(runId)
    const questionHistory: Question[] = questions.map((q) => ({
      question: q.question,
      answer: q.answer,
    }))

    // Ask Claude what to do
    const { decision, usage } = await getNextDecision({
      goal: run.goal,
      featureName: run.featureName,
      stepHistory,
      currentStep: { url, title, pageContent },
      questionHistory,
    })

    await deps.incrementTokenUsage(runId, usage.inputTokens + usage.outputTokens)

    // Execute the decision
    if (decision.action === 'act' || decision.action === 'navigate') {
      const screenshotPath = await explorationBrowser.captureAndUploadScreenshot(
        session,
        runId,
        stepIndex,
      )

      await deps.createRunStep({
        runId,
        stepIndex,
        url,
        title,
        action: decision.instruction,
        observation: pageContent.slice(0, 500),
        screenshotPath,
      })

      if (decision.action === 'navigate') {
        await explorationBrowser.navigateTo(session, decision.instruction)
      } else {
        await explorationBrowser.performAction(session, decision.instruction)
      }

      return { done: false, status: 'running', decision, stepIndex }
    }

    if (decision.action === 'ask') {
      const lastStep = await deps.createRunStep({
        runId,
        stepIndex,
        url,
        title,
        action: 'ask',
        observation: decision.question,
        status: 'blocked',
      })
      await deps.createQuestion({ runId, stepId: lastStep.id, question: decision.question })
      await deps.updateRunStatus(runId, 'blocked')
      await closeBrowser(session)
      return { done: true, status: 'blocked', decision, stepIndex }
    }

    if (decision.action === 'blocked') {
      await deps.createRunStep({
        runId,
        stepIndex,
        url,
        title,
        action: 'blocked',
        observation: decision.reason,
        status: 'blocked',
      })
      await deps.updateRunStatus(runId, 'blocked')
      await closeBrowser(session)
      return { done: true, status: 'blocked', decision, stepIndex }
    }

    // finish
    await deps.createRunStep({
      runId,
      stepIndex,
      url,
      title,
      action: 'finish',
      observation: decision.summary,
    })
    await deps.updateRunStatus(runId, 'completed')
    await closeBrowser(session)
    return { done: true, status: 'completed', decision, stepIndex }
  } catch (err) {
    console.error(`Step failed for run ${runId}:`, err)
    await deps.updateRunStatus(runId, 'failed')
    await closeBrowser(session)
    return { done: true, status: 'failed', decision: null, stepIndex: -1 }
  }
}
