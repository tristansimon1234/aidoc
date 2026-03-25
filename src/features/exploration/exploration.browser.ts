import type { StagehandSession } from '../../shared/browser/playwright.client.js'
import { uploadToStorage } from '../../shared/db/storage.repository.js'
import type { PageSnapshot } from '../../shared/browser/browser.types.js'

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
  pageContent: string
}> {
  const page = getActivePage(session)
  const url = page.url()
  const title = await page.title()

  // Use extract() with no args — returns raw page text, no AI call
  const result = await session.extract()
  const pageContent = result.pageText.slice(0, 2000)

  return { url, title, pageContent }
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
