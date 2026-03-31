import { Stagehand } from '@browserbasehq/stagehand'
import { STAGEHAND_MODEL } from '../ai/anthropic.client.js'
import { env } from '../config/env.js'

export type StagehandSession = Stagehand

export async function launchBrowser(existingSessionId?: string): Promise<StagehandSession> {
  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: env.BROWSERBASE_API_KEY,
    projectId: env.BROWSERBASE_PROJECT_ID,
    model: {
      modelName: STAGEHAND_MODEL,
      apiKey: env.ANTHROPIC_API_KEY,
    },
    ...(existingSessionId ? { browserbaseSessionID: existingSessionId } : {}),
    keepAlive: true,
    disablePino: true,
    experimental: true,
    disableAPI: true,
    verbose: 0,
  })

  await stagehand.init()
  return stagehand
}

export function getSessionId(session: StagehandSession): string | undefined {
  return session.browserbaseSessionID
}

export async function closeBrowser(session: StagehandSession): Promise<void> {
  await session.close()
}
