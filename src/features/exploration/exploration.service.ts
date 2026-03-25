import { launchBrowser, closeBrowser } from '../../shared/browser/playwright.client.js'
import * as runRepo from '../run/run.repository.js'
import * as questionRepo from '../questions/questions.repository.js'
import * as explorationBrowser from './exploration.browser.js'
import { getNextDecision } from './exploration.agent.js'
import type { StepSummary, Question } from './exploration.types.js'

const MAX_STEPS = 50

export async function executeRun(runId: string): Promise<void> {
  await runRepo.updateRunStatus(runId, 'running')
  const run = await runRepo.findRunById(runId)
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

      const questions = await questionRepo.findQuestionsByRunId(runId)
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

      await runRepo.incrementTokenUsage(runId, usage.inputTokens + usage.outputTokens)

      if (decision.action === 'continue') {
        const screenshotPath = await explorationBrowser.captureAndUploadScreenshot(
          session.page,
          runId,
          stepIndex,
        )

        await runRepo.createRunStep({
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
        const lastStep = await runRepo.createRunStep({
          runId,
          stepIndex,
          url,
          title,
          action: 'ask',
          observation: decision.question,
          status: 'blocked',
        })

        await questionRepo.createQuestion({
          runId,
          stepId: lastStep.id,
          question: decision.question,
        })

        await runRepo.updateRunStatus(runId, 'blocked')
        return
      } else if (decision.action === 'blocked') {
        await runRepo.createRunStep({
          runId,
          stepIndex,
          url,
          title,
          action: 'blocked',
          observation: decision.reason,
          status: 'blocked',
        })

        await runRepo.updateRunStatus(runId, 'blocked')
        return
      } else if (decision.action === 'finish') {
        await runRepo.createRunStep({
          runId,
          stepIndex,
          url,
          title,
          action: 'finish',
          observation: decision.summary,
        })

        await runRepo.updateRunStatus(runId, 'completed')
        return
      }
    }

    await runRepo.updateRunStatus(runId, 'completed')
  } catch (err) {
    console.error(`Run ${runId} failed:`, err)
    await runRepo.updateRunStatus(runId, 'failed')
    throw err
  } finally {
    await closeBrowser(session)
  }
}

async function executeAction(page: import('playwright').Page, action: string): Promise<void> {
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
