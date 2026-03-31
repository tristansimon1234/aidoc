import type { StagehandSession } from '../../shared/browser/playwright.client.js'
import { uploadToStorage } from '../../shared/db/storage.repository.js'

export async function navigateTo(session: StagehandSession, url: string): Promise<void> {
  const page = session.context.activePage()
  if (!page) throw new Error('No active page')
  await page.goto(url, { waitUntil: 'networkidle' })
}

export async function captureScreenshot(
  session: StagehandSession,
  runId: string,
  stepIndex: number,
): Promise<string | null> {
  try {
    const page = session.context.activePage()
    if (!page) return null
    const screenshot = await page.screenshot({ type: 'png' })
    const path = `runs/${runId}/step-${stepIndex}.png`
    return await uploadToStorage('artifacts', path, screenshot, 'image/png')
  } catch (err) {
    console.warn(`Screenshot capture failed for step ${stepIndex}:`, err)
    return null
  }
}
