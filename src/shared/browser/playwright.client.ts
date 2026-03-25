import { Stagehand } from '@browserbasehq/stagehand'
import { env } from '../config/env.js'

export type StagehandSession = Stagehand

export async function launchBrowser(existingSessionId?: string): Promise<StagehandSession> {
  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: env.BROWSERBASE_API_KEY,
    projectId: env.BROWSERBASE_PROJECT_ID,
    model: {
      modelName: 'anthropic/claude-haiku-4-5-20251001',
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
