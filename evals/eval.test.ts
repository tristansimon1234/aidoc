import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { generateDocumentation } from '../src/features/documentation/documentation.generator.js'
import { scoreHeuristics, scoreLlmJudge } from './scorer.js'
import type { EvalFixture, EvalCriteria } from './types.js'

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures')
const CRITERIA_DIR = join(import.meta.dirname, 'criteria')

function loadFixture(name: string): EvalFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')) as EvalFixture
}

function loadCriteria(name: string): EvalCriteria {
  return JSON.parse(readFileSync(join(CRITERIA_DIR, `${name}.json`), 'utf-8')) as EvalCriteria
}

// Discover all fixtures automatically
const fixtureNames = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => basename(f, '.json'))

describe('Documentation generation evals', () => {
  for (const name of fixtureNames) {
    it(`generates quality doc for ${name}`, async () => {
      const fixture = loadFixture(name)
      const criteria = loadCriteria(name)

      // Generate documentation from fixture steps
      const result = await generateDocumentation({
        featureName: fixture.featureName,
        goal: fixture.goal,
        startUrl: fixture.startUrl,
        steps: fixture.steps,
        projectContext: fixture.projectContext,
        questions: fixture.questions,
        runStatus: fixture.runStatus,
      })

      // Heuristic scoring
      const h = scoreHeuristics(result.markdown, result.json, criteria)

      // LLM judge scoring
      const llm = await scoreLlmJudge(result.markdown, criteria)

      // Print scores for visibility
      console.log(`\n--- ${name} ---`)
      console.log(`  Sections: ${h.sections} (min: ${criteria.minSections})`)
      console.log(`  Length: ${h.length} chars`)
      console.log(`  Screenshots: ${h.screenshots}`)
      console.log(`  Mentions hit: ${h.mentionsHit.join(', ')}`)
      console.log(`  Mentions missed: ${h.mentionsMissed.join(', ') || 'none'}`)
      console.log(`  Hallucinations: ${h.hallucinations.join(', ') || 'none'}`)
      console.log(`  Completeness: ${h.completeness}% (min: ${criteria.minCompleteness}%)`)
      console.log(`  Language match: ${h.languageMatch}`)
      console.log(`  JSON parsed: ${h.jsonParsed}`)
      console.log(`  LLM Judge: accuracy=${llm.accuracy} structure=${llm.structure} clarity=${llm.clarity} noHallucination=${llm.noHallucination} overall=${llm.overall}/5`)
      console.log(`  Judge reasoning: ${llm.reasoning}`)
      console.log(`  Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`)

      // Assertions — heuristics
      expect(h.sections, `Expected at least ${criteria.minSections} sections (H2)`).toBeGreaterThanOrEqual(criteria.minSections)
      expect(h.mentionsMissed, `Missing mentions: ${h.mentionsMissed.join(', ')}`).toHaveLength(0)
      expect(h.hallucinations, `Hallucination markers found: ${h.hallucinations.join(', ')}`).toHaveLength(0)
      expect(h.length, 'Doc should be at least 500 chars').toBeGreaterThanOrEqual(500)
      expect(h.jsonParsed, 'Self-assessment JSON should parse correctly').toBe(true)
      expect(h.languageMatch, `Expected language: ${criteria.language}`).toBe(true)
      expect(h.completeness, `Completeness ${h.completeness}% below minimum ${criteria.minCompleteness}%`).toBeGreaterThanOrEqual(criteria.minCompleteness)

      // Assertions — LLM judge
      expect(llm.overall, `LLM judge overall score ${llm.overall}/5 is too low`).toBeGreaterThanOrEqual(3)
    }, 120_000) // 2 min timeout — Claude generation + judge
  }
})
