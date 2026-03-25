import {
  launchBrowser,
  closeBrowser,
  type StagehandSession,
} from '../../shared/browser/playwright.client.js'
import * as explorationBrowser from './exploration.browser.js'
import { getNextDecision } from './exploration.agent.js'
import type { StepSummary, Question } from './exploration.types.js'

const MAX_STEPS = 50

export interface RunDeps {
  findRunById: (id: string) => Promise<{
    startUrl: string
    goal: string
    featureName: string
  } | null>
  updateRunStatus: (id: string, status: 'pending' | 'running' | 'blocked' | 'completed' | 'failed') => Promise<unknown>
  incrementTokenUsage: (id: string, tokens: number) => Promise<void>
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
  findQuestionsByRunId: (runId: string) => Promise<{ question: string; answer: string | null }[]>
  createQuestion: (input: { runId: string; stepId: string; question: string }) => Promise<unknown>
}

export async function executeRun(runId: string, deps: RunDeps): Promise<void> {
  await deps.updateRunStatus(runId, 'running')
  const run = await deps.findRunById(runId)
  if (!run) throw new Error(`Run ${runId} not found`)

  const session = await launchBrowser()

  try {
    await explorationBrowser.navigateTo(session, run.startUrl)

    const stepHistory: StepSummary[] = []
    let stepIndex = 0

    while (stepIndex < MAX_STEPS) {
      const { url, title, observedActions } = await explorationBrowser.getPageContext(session)

      const questions = await deps.findQuestionsByRunId(runId)
      const questionHistory: Question[] = questions.map((q) => ({
        question: q.question,
        answer: q.answer,
      }))

      const { decision, usage } = await getNextDecision({
        goal: run.goal,
        featureName: run.featureName,
        stepHistory,
        currentStep: { url, title, observedActions },
        questionHistory,
      })

      await deps.incrementTokenUsage(runId, usage.inputTokens + usage.outputTokens)

      if (decision.action === 'act' || decision.action === 'navigate') {
        const screenshotPath = await explorationBrowser.captureAndUploadScreenshot(
          session,
          runId,
          stepIndex,
        )

        const instruction = decision.instruction

        await deps.createRunStep({
          runId,
          stepIndex,
          url,
          title,
          action: instruction,
          observation: observedActions.slice(0, 200),
          screenshotPath,
        })

        stepHistory.push({
          url,
          action: instruction,
          observation: observedActions.slice(0, 200),
        })

        await executeDecision(session, decision)
        stepIndex++
      } else if (decision.action === 'ask') {
        const lastStep = await deps.createRunStep({
          runId,
          stepIndex,
          url,
          title,
          action: 'ask',
          observation: decision.question,
          status: 'blocked',
        })

        await deps.createQuestion({
          runId,
          stepId: lastStep.id,
          question: decision.question,
        })

        await deps.updateRunStatus(runId, 'blocked')
        return
      } else if (decision.action === 'blocked') {
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
        return
      } else if (decision.action === 'finish') {
        await deps.createRunStep({
          runId,
          stepIndex,
          url,
          title,
          action: 'finish',
          observation: decision.summary,
        })

        await deps.updateRunStatus(runId, 'completed')
        return
      }
    }

    await deps.updateRunStatus(runId, 'completed')
  } catch (err) {
    console.error(`Run ${runId} failed:`, err)
    await deps.updateRunStatus(runId, 'failed')
    throw err
  } finally {
    await closeBrowser(session)
  }
}

async function executeDecision(
  session: StagehandSession,
  decision: { action: 'act'; instruction: string } | { action: 'navigate'; instruction: string },
): Promise<void> {
  if (decision.action === 'navigate') {
    await explorationBrowser.navigateTo(session, decision.instruction)
  } else {
    await explorationBrowser.performAction(session, decision.instruction)
  }
}
