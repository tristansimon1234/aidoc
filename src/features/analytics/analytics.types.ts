export type AnalyticsPeriod = '7d' | '30d' | '90d'
export type ChatSource = 'widget' | 'public' | 'app'
export type ViewSource = 'public' | 'app'
export type MessageCategory = 'onboarding' | 'pricing' | 'how-to' | 'error' | 'integration' | 'account' | 'other'

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

/** SQL-derived pain-point bucket (one per message category). */
export interface PainPoint {
  category: MessageCategory
  total: number
  negative: number
  frustrated: number
  examples: string[]
}

export interface FrustrationSignal {
  content: string
  source: ChatSource
  createdAt: string
  category: MessageCategory | null
}

/** On-demand recommendations (explicit action — see POST /analytics/recommendations). */
export interface AiRecommendations {
  generatedAt: string
  summary: string
  items: {
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
  painPoints: PainPoint[]
  frustrationSignals: FrustrationSignal[]
  recentSamples: {
    role: 'user' | 'assistant'
    content: string
    source: ChatSource
    createdAt: string
    sentiment: 'positive' | 'neutral' | 'negative' | null
    frustrationFlag: boolean
    language: string | null
    category: MessageCategory | null
  }[]
}
