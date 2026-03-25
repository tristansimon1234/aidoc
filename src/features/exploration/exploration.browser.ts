import type { StagehandSession } from '../../shared/browser/playwright.client.js'
import { uploadToStorage } from '../../shared/db/storage.repository.js'
import type { PageSnapshot, ObservedAction } from '../../shared/browser/browser.types.js'

function getActivePage(session: StagehandSession) {
  const page = session.context.activePage()
  if (!page) throw new Error('No active page in Stagehand session')
  return page
}

export async function navigateTo(session: StagehandSession, url: string): Promise<void> {
  const page = getActivePage(session)
  await page.goto(url, { waitUntil: 'networkidle' })
}

export async function performAction(session: StagehandSession, instruction: string): Promise<void> {
  await session.act(instruction)
}

export async function extractContent(session: StagehandSession, instruction: string): Promise<string> {
  const result = await session.extract(instruction)
  return result.extraction
}

export async function observeActions(session: StagehandSession): Promise<ObservedAction[]> {
  const actions = await session.observe('What interactive elements and actions are available on this page?')
  return actions.map((a) => ({
    description: a.description,
    selector: a.selector,
  }))
}

export async function getPageSnapshot(session: StagehandSession): Promise<PageSnapshot> {
  const page = getActivePage(session)
  const url = page.url()
  const title = await page.title()
  const screenshot = await page.screenshot({ type: 'png' })
  return { url, title, screenshot }
}

export async function getPageContext(session: StagehandSession): Promise<{
  url: string
  title: string
  observedActions: string
}> {
  const page = getActivePage(session)
  const url = page.url()
  const title = await page.title()
  const observations = await observeActions(session)
  const observedActions = observations
    .slice(0, 20)
    .map((o) => `- ${o.description} (${o.selector})`)
    .join('\n')

  return { url, title, observedActions }
}

export async function captureAndUploadScreenshot(
  session: StagehandSession,
  runId: string,
  stepIndex: number,
): Promise<string> {
  const page = getActivePage(session)
  const screenshot = await page.screenshot({ type: 'png' })
  const path = `runs/${runId}/step-${stepIndex}.png`
  return uploadToStorage('artifacts', path, screenshot, 'image/png')
}
