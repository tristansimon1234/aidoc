import { Stagehand } from '@browserbasehq/stagehand'
import { env } from '../config/env.js'

export type StagehandSession = Stagehand

export async function launchBrowser(): Promise<StagehandSession> {
  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: env.BROWSERBASE_API_KEY,
    projectId: env.BROWSERBASE_PROJECT_ID,
    model: {
      modelName: 'anthropic/claude-sonnet-4-20250514',
      apiKey: env.ANTHROPIC_API_KEY,
    },
  })

  await stagehand.init()
  return stagehand
}

export async function closeBrowser(session: StagehandSession): Promise<void> {
  await session.close()
}
