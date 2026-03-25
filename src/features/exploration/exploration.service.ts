import type { Page } from 'playwright'
import { launchBrowser, closeBrowser } from '../../shared/browser/playwright.client.js'
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
  updateRunStatus: (id: string, status: string) => Promise<unknown>
  incrementTokenUsage: (id: string, tokens: number) => Promise<void>
  createRunStep: (input: {
    runId: string
    stepIndex: number
    url?: string
    title?: string
    action?: string
    observation?: string
    screenshotPath?: string
    status?: string
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
    await explorationBrowser.navigateTo(session.page, run.startUrl)

    const stepHistory: StepSummary[] = []
    let stepIndex = 0

    while (stepIndex < MAX_STEPS) {
      const visibleElements = await explorationBrowser.getVisibleElements(session.page)
      const url = session.page.url()
      const title = await session.page.title()

      const questions = await deps.findQuestionsByRunId(runId)
      const questionHistory: Question[] = questions.map((q) => ({
        question: q.question,
        answer: q.answer,
      }))

      const { decision, usage } = await getNextDecision({
        goal: run.goal,
        featureName: run.featureName,
        stepHistory,
        currentStep: { url, title, visibleElements },
        questionHistory,
      })

      await deps.incrementTokenUsage(runId, usage.inputTokens + usage.outputTokens)

      if (decision.action === 'continue') {
        const screenshotPath = await explorationBrowser.captureAndUploadScreenshot(
          session.page,
          runId,
          stepIndex,
        )

        await deps.createRunStep({
          runId,
          stepIndex,
          url,
          title,
          action: decision.nextAction,
          observation: visibleElements.slice(0, 200),
          screenshotPath,
        })

        stepHistory.push({
          url,
          action: decision.nextAction,
          observation: visibleElements.slice(0, 200),
        })

        await executeAction(session.page, decision.nextAction)
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

async function executeAction(page: Page, action: string): Promise<void> {
  const clickMatch = action.match(/^click\s+(.+)$/i)
  if (clickMatch?.[1]) {
    await explorationBrowser.clickElement(page, clickMatch[1])
    return
  }

  const fillMatch = action.match(/^fill\s+(.+?)\s+with\s+"(.+)"$/i)
  if (fillMatch?.[1] && fillMatch[2]) {
    await explorationBrowser.fillInput(page, fillMatch[1], fillMatch[2])
    return
  }

  const navMatch = action.match(/^navigate\s+(.+)$/i)
  if (navMatch?.[1]) {
    await explorationBrowser.navigateTo(page, navMatch[1])
    return
  }
}
