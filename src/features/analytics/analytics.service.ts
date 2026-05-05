import { NotFoundError, AppError } from '../../shared/middleware/error.middleware.js'
import { findProjectById } from '../project/project.repository.js'
import { assertTeamMembership } from '../project/project.service.js'
import { findPagesByProjectId } from '../page/page.repository.js'
import { generateText } from '../../shared/ai/gemini.client.js'
import {
  ANALYTICS_SYSTEM_PROMPT,
  buildAnalyticsPrompt,
  MESSAGE_CLASSIFIER_SYSTEM_PROMPT,
  buildMessageClassifierPrompt,
} from '../../shared/ai/prompt.builder.js'
import { AiRecommendationsSchema } from './analytics.schema.js'
import {
  fetchChatRowsSince,
  fetchPageViewsSince,
  computeChatStats,
  computeViewStats,
  computePainPoints,
  sampleUserMessages,
  updateMessageClassification,
  findUnclassifiedUserMessages,
  type MessageCategory,
} from './analytics.repository.js'
import type { AiRecommendations, AnalyticsPeriod, AnalyticsReport, ChatSource, FrustrationSignal } from './analytics.types.js'

const PERIOD_DAYS: Record<AnalyticsPeriod, number> = { '7d': 7, '30d': 30, '90d': 90 }

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
  await assertTeamMembership(project.teamId, ownerUserId)

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
  const painPoints = computePainPoints(chatRows)

  // Top frustration signals: surface the 10 most recent user messages flagged frustrated.
  const frustrationSignals: FrustrationSignal[] = chatRows
    .filter((r) => r.role === 'user' && r.frustration_flag)
    .slice(0, 10)
    .map((r) => ({
      content: r.content.length > 240 ? `${r.content.slice(0, 240)}…` : r.content,
      source: r.source,
      createdAt: r.created_at,
      category: r.category,
    }))

  const recentSamples = chatRows.slice(0, 40).map((r) => ({
    role: r.role,
    content: r.content.length > 300 ? `${r.content.slice(0, 300)}…` : r.content,
    source: r.source as ChatSource,
    createdAt: r.created_at,
    sentiment: r.sentiment ?? null,
    frustrationFlag: Boolean(r.frustration_flag),
    language: r.language ?? null,
    category: r.category,
  }))

  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    period,
    chatStats,
    viewStats,
    painPoints,
    frustrationSignals,
    recentSamples,
  }
}

// --- On-demand recommendations (explicit owner action, not automatic) ---

const RECO_COOLDOWN_MS = 5 * 60 * 1000
const recommendationsCache = new Map<string, { result: AiRecommendations; expiresAt: number }>()

export async function getRecommendations(
  projectId: string,
  ownerUserId: string,
  period: AnalyticsPeriod,
): Promise<AiRecommendations> {
  const project = await findProjectById(projectId)
  if (!project) throw new NotFoundError('Project')
  await assertTeamMembership(project.teamId, ownerUserId)

  const cacheKey = `${projectId}:${period}`
  const cached = recommendationsCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) return cached.result

  const days = PERIOD_DAYS[period]
  const periodEnd = new Date()
  const periodStart = new Date(periodEnd.getTime() - days * 24 * 60 * 60 * 1000)
  const sinceIso = periodStart.toISOString()

  const [chatRows, viewRows, pages] = await Promise.all([
    fetchChatRowsSince(projectId, sinceIso),
    fetchPageViewsSince(projectId, sinceIso),
    findPagesByProjectId(projectId),
  ])
  const chatStats = computeChatStats(chatRows)
  const viewStats = computeViewStats(viewRows, new Map(pages.map((p) => [p.slug, p.title])))
  const samples = sampleUserMessages(chatRows, 200)

  if (samples.length < 20) {
    throw new AppError('Not enough data yet — wait for more chat traffic.', 'NOT_ENOUGH_DATA', 409)
  }

  const userPrompt = buildAnalyticsPrompt({
    productName: project.name,
    productDescription: project.description,
    sessionCount: chatStats.totalSessions,
    messageCount: chatStats.totalMessages,
    sampleUserMessages: samples,
    topPages: viewStats.topPages,
    allPageTitles: pages.map((p) => p.title),
  })

  const response = await generateText({
    systemPrompt: ANALYTICS_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 2048,
  })
  const parsed = parseGeminiJson(response.text)
  const validated = AiRecommendationsSchema.parse(parsed)

  const result: AiRecommendations = {
    generatedAt: new Date().toISOString(),
    summary: validated.summary,
    items: validated.items,
  }
  recommendationsCache.set(cacheKey, { result, expiresAt: Date.now() + RECO_COOLDOWN_MS })
  return result
}

// --- Per-message classifier (write-time, fire-and-forget) ---

const VALID_CATEGORIES: readonly MessageCategory[] = ['onboarding', 'pricing', 'how-to', 'error', 'integration', 'account', 'other']

interface ClassifyResult {
  sentiment: 'positive' | 'neutral' | 'negative'
  frustrated: boolean
  language: string | null
  category: MessageCategory | null
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
    const category = typeof parsed.category === 'string' && (VALID_CATEGORIES as readonly string[]).includes(parsed.category)
      ? (parsed.category as MessageCategory)
      : 'other'
    return {
      sentiment,
      frustrated: Boolean(parsed.frustrated),
      language: typeof parsed.language === 'string' ? parsed.language.slice(0, 8) : null,
      category,
    }
  } catch { return null }
}

export async function classifyAndStoreUserMessage(messageId: string, content: string): Promise<void> {
  const classified = await classifyMessageContent(content)
  if (!classified) return
  try {
    await updateMessageClassification(messageId, {
      sentiment: classified.sentiment,
      frustration_flag: classified.frustrated,
      language: classified.language,
      category: classified.category,
    })
  } catch (err) {
    console.warn('[analytics] classifier UPDATE failed:', (err as Error).message)
  }
}

/** Pure Gemini call — callable in parallel with the chat reply generation so
 *  the classifier never adds latency to the user-visible response. */
export async function classifyMessageContent(content: string): Promise<ClassifyResult | null> {
  const preview = content.slice(0, 80)
  try {
    console.log(`[classifier] start "${preview}"`)
    // Gemini 2.5 Flash spends tokens on "thinking" before emitting output, and
    // both are counted against maxOutputTokens. Under ~400 the thinking eats
    // the whole budget and the JSON comes back truncated like `{"sentiment": "`.
    const result = await generateText({
      systemPrompt: MESSAGE_CLASSIFIER_SYSTEM_PROMPT,
      userPrompt: buildMessageClassifierPrompt(content),
      maxTokens: 512,
    })
    console.log(`[classifier] raw response: ${result.text.slice(0, 300)}`)
    const parsed = parseClassifierResponse(result.text)
    if (!parsed) {
      console.warn(`[classifier] parse rejected — raw was: ${result.text}`)
    } else {
      console.log(`[classifier] parsed: ${JSON.stringify(parsed)}`)
    }
    return parsed
  } catch (err) {
    console.warn(`[classifier] Gemini call failed for "${preview}": ${(err as Error).message}`)
    return null
  }
}

export async function applyClassificationToMessage(
  messageId: string,
  classified: ClassifyResult,
): Promise<void> {
  try {
    await updateMessageClassification(messageId, {
      sentiment: classified.sentiment,
      frustration_flag: classified.frustrated,
      language: classified.language,
      category: classified.category,
    })
    console.log(`[classifier] UPDATE ok for ${messageId} → ${JSON.stringify(classified)}`)
  } catch (err) {
    console.warn(`[classifier] UPDATE failed for ${messageId}: ${(err as Error).message}`)
  }
}

// --- Cron-driven batch classifier ---

/** Concurrency cap for the cron's parallel Gemini calls. Gemini 2.5 Flash
 *  holds ~60 RPM on the free tier; 5 in flight leaves room for live chat
 *  to continue serving while the hourly batch catches up. */
const CRON_CLASSIFY_CONCURRENCY = 5
/** Max messages processed per cron tick. At 60 RPM × concurrency 5 we can
 *  drain ~1000 in 5 minutes comfortably; cap below that to avoid chaining
 *  many Gemini calls per invocation. The cron runs hourly, so steady-state
 *  traffic well under 300 messages/hour is fully absorbed. */
const CRON_CLASSIFY_BATCH_LIMIT = 300

/**
 * Pull every unclassified user message from the last 72h and classify them
 * in bounded-concurrency waves. Invoked hourly by the Vercel cron at
 * /api/cron/classify-messages — see src/features/analytics/cron.routes.ts.
 *
 * Moving classification off the live chat path means:
 *   - Live chat latency is no longer bounded by the classifier Gemini call
 *   - Gemini quota (~60 RPM) isn't halved between chat + classify per
 *     message, so the widget no longer 429s under multi-user demos
 *   - Analytics insights lag by up to ~1h, which is acceptable for
 *     sentiment / frustration aggregates
 */
export async function classifyPendingMessages(): Promise<{ picked: number; updated: number; failed: number }> {
  const pending = await findUnclassifiedUserMessages(CRON_CLASSIFY_BATCH_LIMIT)
  if (pending.length === 0) return { picked: 0, updated: 0, failed: 0 }

  let updated = 0
  let failed = 0
  for (let i = 0; i < pending.length; i += CRON_CLASSIFY_CONCURRENCY) {
    const wave = pending.slice(i, i + CRON_CLASSIFY_CONCURRENCY)
    const outcomes = await Promise.allSettled(
      wave.map(async (m) => {
        const c = await classifyMessageContent(m.content)
        if (!c) return 'skipped' as const
        await applyClassificationToMessage(m.id, c)
        return 'ok' as const
      }),
    )
    for (const r of outcomes) {
      if (r.status === 'fulfilled' && r.value === 'ok') updated++
      else if (r.status === 'rejected') failed++
    }
  }
  console.log(`[classifier cron] picked=${pending.length} updated=${updated} failed=${failed}`)
  return { picked: pending.length, updated, failed }
}
