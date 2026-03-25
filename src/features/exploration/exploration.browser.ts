import type { Page } from 'playwright'
import { uploadToStorage } from '../../shared/db/storage.repository.js'
import type { PageSnapshot } from '../../shared/browser/browser.types.js'

export async function navigateTo(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.waitForLoadState('networkidle')
}

export async function clickElement(page: Page, selector: string): Promise<void> {
  await page.click(selector)
  await page.waitForLoadState('networkidle')
}

export async function fillInput(page: Page, selector: string, value: string): Promise<void> {
  await page.fill(selector, value)
}

export async function getPageSnapshot(page: Page): Promise<PageSnapshot> {
  const url = page.url()
  const title = await page.title()
  const screenshot = await page.screenshot({ type: 'png' })
  return { url, title, screenshot }
}

export async function getVisibleElements(page: Page): Promise<string> {
  return page.evaluate(() => {
    const elements: string[] = []
    const interactable = document.querySelectorAll(
      'a, button, input, select, textarea, [role="button"], [role="link"]',
    )
    interactable.forEach((el) => {
      const tag = el.tagName.toLowerCase()
      const text = (el as HTMLElement).innerText?.trim().slice(0, 50) ?? ''
      const id = el.id ? `#${el.id}` : ''
      const cls =
        el.className && typeof el.className === 'string'
          ? `.${el.className.split(' ').slice(0, 2).join('.')}`
          : ''
      elements.push(`<${tag}${id}${cls}> ${text}`)
    })
    return elements.slice(0, 30).join('\n')
  })
}

export async function captureAndUploadScreenshot(
  page: Page,
  runId: string,
  stepIndex: number,
): Promise<string> {
  const screenshot = await page.screenshot({ type: 'png' })
  const path = `runs/${runId}/step-${stepIndex}.png`
  return uploadToStorage('artifacts', path, screenshot, 'image/png')
}
