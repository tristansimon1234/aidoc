import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'
import type { ChatSource, ChatStats, ViewSource, ViewStats } from './analytics.types.js'

// --- Writes (fire-and-forget from the chat / view ping handlers) ---

export async function logChatMessages(input: {
  projectId: string
  userId: string
  sessionToken: string
  source: ChatSource
  userMessage: string
  assistantMessage: string
}): Promise<{ userMessageId: string | null }> {
  const now = new Date()
  // Insert assistant a few ms later so ORDER BY created_at puts user first
  const rows = [
    {
      project_id: input.projectId,
      user_id: input.userId,
      session_token: input.sessionToken,
      role: 'user',
      content: input.userMessage.slice(0, 8000),
      source: input.source,
      created_at: now.toISOString(),
    },
    {
      project_id: input.projectId,
      user_id: input.userId,
      session_token: input.sessionToken,
      role: 'assistant',
      content: input.assistantMessage.slice(0, 16000),
      source: input.source,
      created_at: new Date(now.getTime() + 1).toISOString(),
    },
  ]
  const { data, error } = await supabase.from('chat_messages').insert(rows).select('id, role')
  if (error) throw new DatabaseError(error.message)
  const userRow = (data ?? []).find((r) => (r as { role: string }).role === 'user') as { id: string } | undefined
  return { userMessageId: userRow?.id ?? null }
}

export async function updateMessageClassification(
  messageId: string,
  fields: { sentiment: 'positive' | 'neutral' | 'negative'; frustration_flag: boolean; language: string | null },
): Promise<void> {
  const { error } = await supabase
    .from('chat_messages')
    .update({
      sentiment: fields.sentiment,
      frustration_flag: fields.frustration_flag,
      language: fields.language,
    })
    .eq('id', messageId)
  if (error) throw new DatabaseError(error.message)
}

export async function logPageView(input: {
  projectId: string
  userId: string
  pageId: string | null
  pageSlug: string
  sessionToken: string
  source: ViewSource
}): Promise<void> {
  const { error } = await supabase.from('doc_page_views').insert({
    project_id: input.projectId,
    user_id: input.userId,
    page_id: input.pageId,
    page_slug: input.pageSlug,
    session_token: input.sessionToken,
    source: input.source,
  })
  if (error) throw new DatabaseError(error.message)
}

// --- Reads (used by analytics.service) ---

interface ChatRow {
  role: 'user' | 'assistant'
  content: string
  source: ChatSource
  session_token: string
  created_at: string
  sentiment: 'positive' | 'neutral' | 'negative' | null
  frustration_flag: boolean | null
  language: string | null
}

export async function fetchChatRowsSince(projectId: string, sinceIso: string): Promise<ChatRow[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, source, session_token, created_at, sentiment, frustration_flag, language')
    .eq('project_id', projectId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(5000)
  if (error) throw new DatabaseError(error.message)
  return (data ?? []) as ChatRow[]
}

interface ViewRow { page_slug: string; page_id: string | null; session_token: string; source: ViewSource; viewed_at: string }

export async function fetchPageViewsSince(projectId: string, sinceIso: string): Promise<ViewRow[]> {
  const { data, error } = await supabase
    .from('doc_page_views')
    .select('page_slug, page_id, session_token, source, viewed_at')
    .eq('project_id', projectId)
    .gte('viewed_at', sinceIso)
    .order('viewed_at', { ascending: false })
    .limit(10000)
  if (error) throw new DatabaseError(error.message)
  return (data ?? []) as ViewRow[]
}

// --- Aggregations (pure, unit-testable) ---

export function computeChatStats(rows: ChatRow[]): ChatStats {
  const sessionsSet = new Set<string>()
  const bySource: Record<ChatSource, { sessions: Set<string>; messages: number }> = {
    widget: { sessions: new Set(), messages: 0 },
    public: { sessions: new Set(), messages: 0 },
    app: { sessions: new Set(), messages: 0 },
  }
  let userMessages = 0
  let assistantMessages = 0
  let userPositive = 0
  let userNegative = 0
  let userFrustrated = 0
  let userClassified = 0

  for (const r of rows) {
    sessionsSet.add(r.session_token)
    const bucket = bySource[r.source]
    if (bucket) {
      bucket.sessions.add(r.session_token)
      bucket.messages += 1
    }
    if (r.role === 'user') {
      userMessages += 1
      if (r.sentiment) {
        userClassified += 1
        if (r.sentiment === 'positive') userPositive += 1
        else if (r.sentiment === 'negative') userNegative += 1
      }
      if (r.frustration_flag) userFrustrated += 1
    } else {
      assistantMessages += 1
    }
  }

  const totalSessions = sessionsSet.size
  const totalMessages = rows.length
  return {
    totalSessions,
    totalMessages,
    userMessages,
    assistantMessages,
    avgMessagesPerSession: totalSessions === 0 ? 0 : Math.round((totalMessages / totalSessions) * 10) / 10,
    bySource: {
      widget: { sessions: bySource.widget.sessions.size, messages: bySource.widget.messages },
      public: { sessions: bySource.public.sessions.size, messages: bySource.public.messages },
      app: { sessions: bySource.app.sessions.size, messages: bySource.app.messages },
    },
    sentimentCounts: {
      positive: userPositive,
      negative: userNegative,
      frustrated: userFrustrated,
      classified: userClassified,
    },
  }
}

export function computeViewStats(rows: ViewRow[], pageTitleBySlug: Map<string, string>): ViewStats {
  const sessions = new Set<string>()
  const perSlug = new Map<string, number>()
  for (const r of rows) {
    sessions.add(r.session_token)
    perSlug.set(r.page_slug, (perSlug.get(r.page_slug) ?? 0) + 1)
  }
  const topPages = Array.from(perSlug.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([slug, views]) => ({ slug, title: pageTitleBySlug.get(slug) ?? null, views }))
  return {
    totalViews: rows.length,
    uniqueSessions: sessions.size,
    topPages,
  }
}

export function sampleUserMessages(rows: ChatRow[], limit: number): string[] {
  const out: string[] = []
  for (const r of rows) {
    if (r.role !== 'user') continue
    out.push(r.content.slice(0, 400))
    if (out.length >= limit) break
  }
  return out
}
