import Anthropic from '@anthropic-ai/sdk'
import { env } from '../config/env.js'

export const CLAUDE_MODEL = 'claude-sonnet-4-20250514'
export const STAGEHAND_MODEL = 'anthropic/claude-sonnet-4-20250514'

export const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
})
