import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import type { EvalCriteria, HeuristicScore, LlmJudgeScore } from './types.js'

// --- Heuristic scoring ---

const EN_COMMON = ['the', 'and', 'is', 'to', 'in', 'for', 'of', 'with', 'you', 'this']
const FR_COMMON = ['le', 'la', 'les', 'de', 'des', 'est', 'un', 'une', 'et', 'pour']

function detectLanguage(text: string): string {
  const words = text.toLowerCase().split(/\s+/)
  const enCount = words.filter((w) => EN_COMMON.includes(w)).length
  const frCount = words.filter((w) => FR_COMMON.includes(w)).length
  return frCount > enCount ? 'fr' : 'en'
}

export function scoreHeuristics(
  markdown: string,
  json: Record<string, unknown>,
  criteria: EvalCriteria,
): HeuristicScore {
  const lower = markdown.toLowerCase()

  // Count H2 sections
  const sections = (markdown.match(/^## /gm) ?? []).length

  // Count inline screenshots
  const screenshots = (markdown.match(/!\[/g) ?? []).length

  // Check mustMention terms
  const mentionsHit = criteria.mustMention.filter((term) => lower.includes(term.toLowerCase()))
  const mentionsMissed = criteria.mustMention.filter((term) => !lower.includes(term.toLowerCase()))

  // Check mustNotMention (hallucination markers)
  const hallucinations = (criteria.mustNotMention ?? []).filter((term) => lower.includes(term.toLowerCase()))

  // Self-assessment completeness
  const selfAssessment = (json as Record<string, unknown>).selfAssessment as Record<string, unknown> | undefined
  const completeness = typeof selfAssessment?.overallCompleteness === 'number'
    ? selfAssessment.overallCompleteness
    : 0

  // Language detection
  const detected = detectLanguage(markdown)
  const languageMatch = detected === criteria.language

  // JSON parsed correctly (not the fallback error object)
  const gaps = selfAssessment?.gaps as Array<Record<string, unknown>> | undefined
  const jsonParsed = !(
    completeness === 0 &&
    gaps?.length === 1 &&
    gaps[0]?.reason === 'Self-assessment could not be parsed'
  )

  return {
    sections,
    screenshots,
    length: markdown.length,
    mentionsHit,
    mentionsMissed,
    hallucinations,
    completeness,
    languageMatch,
    jsonParsed,
  }
}

// --- LLM Judge scoring ---

const LlmJudgeSchema = z.object({
  accuracy: z.number().min(1).max(5),
  structure: z.number().min(1).max(5),
  clarity: z.number().min(1).max(5),
  noHallucination: z.number().min(1).max(5),
  reasoning: z.string(),
})

export async function scoreLlmJudge(
  markdown: string,
  criteria: EvalCriteria,
): Promise<LlmJudgeScore> {
  const anthropic = new Anthropic()

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are evaluating AI-generated product documentation. Score it on 4 axes (1-5 each).

## Documentation to evaluate
${markdown.slice(0, 8000)}

## Expected content
The documentation should mention: ${criteria.mustMention.join(', ')}
${criteria.mustNotMention?.length ? `It should NOT mention: ${criteria.mustNotMention.join(', ')}` : ''}
Language should be: ${criteria.language}

## Scoring axes
- **accuracy** (1-5): Does the doc accurately describe the product features shown in the exploration? Does it use correct terminology?
- **structure** (1-5): Is the doc well-organized with logical sections, clear headings, and a natural flow?
- **clarity** (1-5): Is it easy to understand for a new user? Clear language, no jargon without explanation?
- **noHallucination** (1-5): Does the doc only describe what was actually explored? No invented features or speculative content?

Respond with JSON only:
{"accuracy": N, "structure": N, "clarity": N, "noHallucination": N, "reasoning": "1-2 sentence explanation"}`,
    }],
  })

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    return { accuracy: 1, structure: 1, clarity: 1, noHallucination: 1, overall: 1, reasoning: 'No response from judge' }
  }

  let jsonStr = textBlock.text.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  try {
    const parsed = LlmJudgeSchema.parse(JSON.parse(jsonStr))
    const overall = (parsed.accuracy + parsed.structure + parsed.clarity + parsed.noHallucination) / 4
    return { ...parsed, overall: Math.round(overall * 10) / 10 }
  } catch {
    return { accuracy: 1, structure: 1, clarity: 1, noHallucination: 1, overall: 1, reasoning: 'Failed to parse judge response' }
  }
}
