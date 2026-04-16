import Anthropic from '@anthropic-ai/sdk'
import { env } from '../config/env.js'

export const STAGEHAND_MODEL = 'anthropic/claude-sonnet-4-20250514'

// Anthropic — optional fallback
export const anthropic = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null
