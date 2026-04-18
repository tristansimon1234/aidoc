import { NotFoundError, AppError } from '../../shared/middleware/error.middleware.js'
import { findProjectById } from '../project/project.repository.js'
import { findPagesByProjectId } from '../page/page.repository.js'
import { generateText } from '../../shared/ai/gemini.client.js'
import {
  ANALYTICS_SYSTEM_PROMPT,
  buildAnalyticsPrompt,
  MESSAGE_CLASSIFIER_SYSTEM_PROMPT,
  buildMessageClassifierPrompt,
} from '../../shared/ai/prompt.builder.js'
import { AiInsightsSchema } from './analytics.schema.js'
import {
  fetchChatRowsSince,
  fetchPageViewsSince,
  computeChatStats,
  computeViewStats,
  sampleUserMessages,
  updateMessageClassification,
} from './analytics.repository.js'
import type { AiInsights, AnalyticsPeriod, AnalyticsReport, ChatSource } from './analytics.types.js'

const PERIOD_DAYS: Record<AnalyticsPeriod, number> = { '7d': 7, '30d': 30, '90d': 90 }
const INSIGHTS_CACHE_TTL_MS = 10 * 60 * 1000
const insightsCache = new Map<string, { insights: AiInsights; expiresAt: number }>()

// Strip Gemini's markdown fences / surrounding chatter, extract the JSON body,
// and attempt a structural repair if the initial parse fails. Same pattern
// used by run.service.ts → analyzeTryDoc.
function parseGeminiJson(raw: string): unknown {
  let jsonStr = raw.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }
  const braceStart = jsonStr.indexOf('{')
  const braceEnd = jsonStr.lastIndexOf('}')
  if (braceStart !== -1 && braceEnd > braceStart) jsonStr = jsonStr.slice(braceStart, braceEnd + 1)

  try {
    return JSON.parse(jsonStr)
  } catch {
    let repaired = jsonStr
      .replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, '')
      .replace(/,\s*\{[^}]*$/, '')
      .replace(/,\s*$/, '')
      .replace(/,\s*}/, '}')
      .replace(/,\s*]/, ']')
    if (repaired.split('"').length % 2 === 0) repaired += '"'
    const openBrackets = (repaired.match(/\[/g) ?? []).length - (repaired.match(/\]/g) ?? []).length
    const openBraces = (repaired.match(/\{/g) ?? []).length - (repaired.match(/\}/g) ?? []).length
    repaired += ']'.repeat(Math.max(0, openBrackets))
    repaired += '}'.repeat(Math.max(0, openBraces))
    return JSON.parse(repaired)
  }
}

export async function getReport(
  projectId: string,
  ownerUserId: string,
  period: AnalyticsPeriod,
): Promise<AnalyticsReport> {
  const project = await findProjectById(projectId)
  if (!project) throw new NotFoundError('Project')
  if (project.userId !== ownerUserId) throw new AppError('Forbidden', 'FORBIDDEN', 403)

  const days = PERIOD_DAYS[period]
  const periodEnd = new Date()
  const periodStart = new Date(periodEnd.getTime() - days * 24 * 60 * 60 * 1000)
  const sinceIso = periodStart.toISOString()

  const [chatRows, viewRows, pages] = await Promise.all([
    fetchChatRowsSince(projectId, sinceIso),
    fetchPageViewsSince(projectId, sinceIso),
    findPagesByProjectId(projectId),
  ])

  const titleBySlug = new Map(pages.map((p) => [p.slug, p.title]))
  const chatStats = computeChatStats(chatRows)
  const viewStats = computeViewStats(viewRows, titleBySlug)

  const samples = sampleUserMessages(chatRows, 200)
  const insights = samples.length > 0
    ? await getCachedInsights(projectId, period, async () => generateInsights({
        productName: project.name,
        productDescription: project.description,
        sessionCount: chatStats.totalSessions,
        messageCount: chatStats.totalMessages,
        sampleUserMessages: samples,
        topPages: viewStats.topPages,
        allPageTitles: pages.map((p) => p.title),
      }))
    : null

  const recentSamples = chatRows.slice(0, 40).map((r) => ({
    role: r.role,
    content: r.content.length > 300 ? `${r.content.slice(0, 300)}…` : r.content,
    source: r.source as ChatSource,
    createdAt: r.created_at,
    sentiment: r.sentiment ?? null,
    frustrationFlag: Boolean(r.frustration_flag),
    language: r.language ?? null,
  }))

  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    period,
    chatStats,
    viewStats,
    insights,
    recentSamples,
  }
}

async function getCachedInsights(
  projectId: string,
  period: AnalyticsPeriod,
  loader: () => Promise<AiInsights>,
): Promise<AiInsights | null> {
  const key = `${projectId}:${period}`
  const cached = insightsCache.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.insights
  try {
    const insights = await loader()
    insightsCache.set(key, { insights, expiresAt: Date.now() + INSIGHTS_CACHE_TTL_MS })
    return insights
  } catch (err) {
    console.warn('[analytics] insights generation failed:', (err as Error).message)
    return null
  }
}

// --- Per-message classifier (write-time, fire-and-forget) ---

interface ClassifyResult {
  sentiment: 'positive' | 'neutral' | 'negative'
  frustrated: boolean
  language: string | null
}

function parseClassifierResponse(raw: string): ClassifyResult | null {
  let jsonStr = raw.trim()
  if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  const braceStart = jsonStr.indexOf('{')
  const braceEnd = jsonStr.lastIndexOf('}')
  if (braceStart === -1 || braceEnd <= braceStart) return null
  jsonStr = jsonStr.slice(braceStart, braceEnd + 1)
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>
    const sentiment = parsed.sentiment
    if (sentiment !== 'positive' && sentiment !== 'neutral' && sentiment !== 'negative') return null
    return {
      sentiment,
      frustrated: Boolean(parsed.frustrated),
      language: typeof parsed.language === 'string' ? parsed.language.slice(0, 8) : null,
    }
  } catch { return null }
}

export async function classifyAndStoreUserMessage(messageId: string, content: string): Promise<void> {
  try {
    const result = await generateText({
      systemPrompt: MESSAGE_CLASSIFIER_SYSTEM_PROMPT,
      userPrompt: buildMessageClassifierPrompt(content),
      maxTokens: 80,
    })
    const parsed = parseClassifierResponse(result.text)
    if (!parsed) return
    await updateMessageClassification(messageId, {
      sentiment: parsed.sentiment,
      frustration_flag: parsed.frustrated,
      language: parsed.language,
    })
  } catch (err) {
    console.warn('[analytics] classifier failed:', (err as Error).message)
  }
}

async function generateInsights(input: {
  productName: string
  productDescription: string | null
  sessionCount: number
  messageCount: number
  sampleUserMessages: string[]
  topPages: { title: string | null; slug: string; views: number }[]
  allPageTitles: string[]
}): Promise<AiInsights> {
  const userPrompt = buildAnalyticsPrompt(input)
  const result = await generateText({
    systemPrompt: ANALYTICS_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 4096,
  })
  const parsed = parseGeminiJson(result.text)
  return AiInsightsSchema.parse(parsed)
}
