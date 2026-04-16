import Anthropic from '@anthropic-ai/sdk'
import { env } from '../config/env.js'

export const STAGEHAND_MODEL = 'google/gemini-3-flash-preview'

// Anthropic — optional fallback
export const anthropic = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null
