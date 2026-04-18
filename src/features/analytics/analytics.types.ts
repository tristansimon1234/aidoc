export type AnalyticsPeriod = '7d' | '30d' | '90d'
export type ChatSource = 'widget' | 'public' | 'app'
export type ViewSource = 'public' | 'app'

export interface ChatStats {
  totalSessions: number
  totalMessages: number
  userMessages: number
  assistantMessages: number
  avgMessagesPerSession: number
  bySource: Record<ChatSource, { sessions: number; messages: number }>
  sentimentCounts: {
    positive: number
    negative: number
    frustrated: number
    classified: number
  }
}

export interface ViewStats {
  totalViews: number
  uniqueSessions: number
  topPages: { slug: string; title: string | null; views: number }[]
}

export interface AiInsights {
  overallSentiment: {
    score: 'positive' | 'neutral' | 'negative' | 'mixed'
    summary: string
  }
  painPoints: {
    topic: string
    frequency: number
    severity: 'high' | 'medium' | 'low'
    examples: string[]
  }[]
  frustrationSignals: {
    excerpt: string
    reason: string
    severity: 'high' | 'medium' | 'low'
  }[]
  contentGaps: {
    question: string
    askedCount: number
    suggestedPage: string | null
  }[]
  recommendations: {
    type: 'content' | 'product' | 'ux'
    title: string
    description: string
    priority: 'high' | 'medium' | 'low'
  }[]
}

export interface AnalyticsReport {
  periodStart: string
  periodEnd: string
  period: AnalyticsPeriod
  chatStats: ChatStats
  viewStats: ViewStats
  insights: AiInsights | null
  recentSamples: {
    role: 'user' | 'assistant'
    content: string
    source: ChatSource
    createdAt: string
    sentiment: 'positive' | 'neutral' | 'negative' | null
    frustrationFlag: boolean
    language: string | null
  }[]
}
