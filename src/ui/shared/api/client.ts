import { supabase } from './supabase.js'

const API_BASE = '/api'

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function getAuthToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? ''
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = await getAuthHeaders()
  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  })

  if (res.status === 401) {
    await supabase.auth.signOut()
    window.location.href = '/login'
    throw new Error('Session expired')
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed: ${res.status}`)
  }

  return res.json() as Promise<T>
}

export interface RunDTO {
  id: string
  featureName: string
  startUrl: string
  goal: string
  status: 'pending' | 'running' | 'blocked' | 'completed' | 'failed'
  tokenUsage: number
  browserbaseSessionId: string | null
  summaryJson: {
    sections: { url: string; label: string; status: string; stepCount: number }[]
    blockers: { type: string; description: string; section: string; actionLabel: string }[]
    agentMessage: string
  } | null
  createdAt: string
  updatedAt: string
}

export interface RunStepDTO {
  id: string
  runId: string
  stepIndex: number
  url: string | null
  title: string | null
  action: string | null
  observation: string | null
  screenshotPath: string | null
  status: string
  createdAt: string
}

export interface GeneratedDocDTO {
  id: string
  runId: string
  markdownContent: string | null
  jsonContent: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface QuestionDTO {
  id: string
  runId: string
  question: string
  answer: string | null
  answeredAt: string | null
  createdAt: string
}

export interface StepEventDTO {
  type: 'step' | 'status' | 'done' | 'error' | 'blocked' | 'close' | 'live' | 'cancelled'
  step?: { type: string; action: string | null; pageUrl: string | null; reasoning: string | null }
  liveUrl?: string
  stepIndex?: number
  message?: string
  completed?: boolean
}

export interface ProjectContextDTO {
  audience: string
  workflow: string
  quirks: string
}

export interface DiscoveredContextDTO {
  lastUpdated: string
  siteStructure: string[]
  navigation: string[]
  terminology: Record<string, string>
  features: string[]
  summary: string
}

export interface ProjectDesignDTO {
  accentColor: string
  bgColor: string
  textColor: string
  font: string
  logoUrl?: string
  widgetPosition?: string
  widgetGreeting?: string
}

export interface ProjectDTO {
  id: string
  userId: string
  name: string
  baseUrl: string
  description: string | null
  context: ProjectContextDTO | null
  discoveredContext: DiscoveredContextDTO | null
  design: ProjectDesignDTO | null
  credentials: { label: string; username: string; password: string }[] | null
  resources: { type: 'url' | 'file' | 'note'; label: string; value: string }[] | null
  widgetApiKey: string | null
  widgetEnabled: boolean
  mcpApiKey: string | null
  mcpEnabled: boolean
  walkthroughEnabled: boolean
  createdAt: string
  updatedAt: string
}

export interface ProfileDTO {
  id: string
  email: string | null
  fullName: string | null
  stripeCustomerId: string | null
  isAdmin: boolean
  createdAt: string
  updatedAt: string
}

export type PlanId = 'free' | 'startup' | 'growth' | 'business'

export interface PlanDTO {
  id: PlanId
  name: string
  priceCents: number
  currency: string
  stripePriceId: string | null
  monthlyTokens: number
  sortOrder: number
  features: string[]
}

export interface SubscriptionDTO {
  id: string
  userId: string
  planId: PlanId
  status: 'active' | 'canceled' | 'past_due' | 'trialing'
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  stripeSubscriptionId: string | null
  cancelAtPeriodEnd: boolean
  createdAt: string
  updatedAt: string
}

export interface UsageSnapshotDTO {
  percent: number
  periodMonth: string
}

export interface BillingSummaryDTO {
  plan: PlanDTO
  subscription: SubscriptionDTO
  usage: UsageSnapshotDTO
}

export type UsageFeatureKey = 'doc_run' | 'voiceover' | 'try_doc' | 'chat_sessions'

export interface AdminUsageRowDTO {
  userId: string
  email: string | null
  fullName: string | null
  planId: PlanId | null
  monthlyTokens: number | null
  counts: Record<UsageFeatureKey, number>
  tokensByFeature: Record<UsageFeatureKey, number>
  tokensUsed: number
  euroByFeature: Record<UsageFeatureKey, number>
  euroCost: number
  percent: number
}

export interface AdminUsageReportDTO {
  periodMonth: string
  users: AdminUsageRowDTO[]
}

export interface PageResourceDTO {
  type: 'url' | 'credential' | 'endpoint' | 'file' | 'note'
  label: string
  value: string
}

export interface PageBriefingDTO {
  objective: string
  knowledge: string
  resources: PageResourceDTO[]
}

export interface DocPageDTO {
  id: string
  projectId: string
  parentId: string | null
  title: string
  slug: string
  startUrl: string | null
  goal: string | null
  content: string | null
  customPrompt: string | null
  briefing: PageBriefingDTO | null
  status: 'draft' | 'exploring' | 'published'
  isPublic: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
  children?: DocPageDTO[]
}

export const api = {
  profile: {
    get: (): Promise<ProfileDTO> => request('/profile'),
    update: (body: { fullName?: string | null }): Promise<ProfileDTO> =>
      request('/profile', { method: 'PATCH', body: JSON.stringify(body) }),
  },
  billing: {
    plans: (): Promise<PlanDTO[]> => request('/billing/plans'),
    summary: (): Promise<BillingSummaryDTO> => request('/billing/summary'),
    selectPlan: (planId: PlanId): Promise<BillingSummaryDTO> =>
      request('/billing/subscription/select', { method: 'POST', body: JSON.stringify({ planId }) }),
  },
  admin: {
    usage: (month?: string): Promise<AdminUsageReportDTO> =>
      request(`/admin/usage${month ? `?month=${encodeURIComponent(month)}` : ''}`),
  },
  projects: {
    list: (): Promise<ProjectDTO[]> => request('/projects'),
    get: (id: string): Promise<ProjectDTO> => request(`/projects/${id}`),
    create: (body: { name: string; baseUrl: string; description?: string; context?: ProjectContextDTO; credentials?: { label: string; username: string; password: string }[] }): Promise<ProjectDTO> =>
      request('/projects', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Record<string, unknown>): Promise<ProjectDTO> =>
      request(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string): Promise<void> => request(`/projects/${id}`, { method: 'DELETE' }),
    analyzeUrl: (url: string): Promise<{ name: string; description: string; audience: string; workflow: string; design?: { accentColor: string; bgColor: string; textColor: string; font: string } }> =>
      request('/projects/analyze-url', { method: 'POST', body: JSON.stringify({ url }) }),
    generateWidgetKey: (id: string): Promise<{ widgetApiKey: string; widgetEnabled: boolean }> =>
      request(`/projects/${id}/widget-key`, { method: 'POST' }),
    disableWidget: (id: string): Promise<{ widgetEnabled: boolean }> =>
      request(`/projects/${id}/widget-key`, { method: 'DELETE' }),
    generateMcpKey: (id: string): Promise<{ mcpApiKey: string; mcpEnabled: boolean }> =>
      request(`/projects/${id}/mcp-key`, { method: 'POST' }),
    disableMcp: (id: string): Promise<{ mcpEnabled: boolean }> =>
      request(`/projects/${id}/mcp-key`, { method: 'DELETE' }),
  },
  pages: {
    list: (projectId: string): Promise<DocPageDTO[]> => request(`/projects/${projectId}/pages`),
    get: (projectId: string, pageId: string): Promise<DocPageDTO> =>
      request(`/projects/${projectId}/pages/${pageId}`),
    full: (projectId: string, pageId: string): Promise<{ page: DocPageDTO; latestRun: RunDTO | null; doc: GeneratedDocDTO | null }> =>
      request(`/projects/${projectId}/pages/${pageId}/full`),
    create: (projectId: string, body: { title: string; slug: string; parentId?: string; startUrl?: string; goal?: string }): Promise<DocPageDTO> =>
      request(`/projects/${projectId}/pages`, { method: 'POST', body: JSON.stringify(body) }),
    update: (projectId: string, pageId: string, body: Record<string, unknown>): Promise<DocPageDTO> =>
      request(`/projects/${projectId}/pages/${pageId}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (projectId: string, pageId: string): Promise<void> =>
      request(`/projects/${projectId}/pages/${pageId}`, { method: 'DELETE' }),
    doc: (projectId: string, pageId: string): Promise<GeneratedDocDTO> =>
      request(`/projects/${projectId}/pages/${pageId}/doc`),
    latestRun: (projectId: string, pageId: string): Promise<RunDTO | null> =>
      request<RunDTO>(`/projects/${projectId}/pages/${pageId}/run`).catch(() => null),
    reorder: (projectId: string, items: { id: string; parentId: string | null; sortOrder: number }[]): Promise<void> =>
      request(`/projects/${projectId}/pages/reorder`, { method: 'PUT', body: JSON.stringify(items) }),
    preflight: (projectId: string, pageId: string): Promise<PreflightResultDTO> =>
      request(`/projects/${projectId}/pages/${pageId}/preflight`, { method: 'POST' }),
  },
  runs: {
    list: (): Promise<RunDTO[]> => request('/runs'),
    get: (id: string): Promise<RunDTO> => request(`/runs/${id}`),
    create: (body: { featureName: string; startUrl: string; goal: string; docPageId?: string }): Promise<RunDTO> =>
      request('/runs', { method: 'POST', body: JSON.stringify(body) }),
    cancel: (id: string): Promise<{ cancelled: boolean }> =>
      request(`/runs/${id}/cancel`, { method: 'POST' }),
    analyzeVideo: (id: string, videoPath: string, options?: { generateDoc?: boolean }): Promise<{ timestamps: number[]; runId?: string; status?: string }> =>
      request(`/runs/${id}/analyze-video`, { method: 'POST', body: JSON.stringify({ videoPath, generateDoc: options?.generateDoc }) }),
    getSignedUploadUrl: (id: string, path: string): Promise<{ signedUrl: string; path: string }> =>
      request(`/runs/${id}/signed-upload-url`, { method: 'POST', body: JSON.stringify({ path }) }),
    updateStepScreenshot: (id: string, stepIndex: number, screenshotPath: string): Promise<{ ok: boolean }> =>
      request(`/runs/${id}/steps/${stepIndex}/screenshot`, { method: 'POST', body: JSON.stringify({ screenshotPath }) }),
    exploreStream: async (
      id: string,
      onEvent: (event: StepEventDTO) => void,
      context?: string,
      signal?: AbortSignal,
    ): Promise<void> => {
      const token = await getAuthToken()

      const res = await fetch(
        `${API_BASE}/runs/${id}/explore`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ context }),
          signal,
        },
      )

      if (!res.ok || !res.body) {
        throw new Error(`Explore failed: ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6)) as StepEventDTO
              onEvent(event)
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    },
    generateDoc: (id: string, options?: { async?: boolean }): Promise<GeneratedDocDTO | { runId: string; status: string }> =>
      request(`/runs/${id}/generate-doc${options?.async ? '?async=1' : ''}`, { method: 'POST' }),
    getVoices: (): Promise<{ voices: { voiceId: string; name: string; category: string; labels: Record<string, string> }[] }> =>
      request('/runs/voices'),
    generateVoiceover: (id: string, options?: { voiceId?: string; language?: string; tone?: string; videoDuration?: number }): Promise<{ audioPath: string; audioUrl: string; duration: number }> =>
      request(`/runs/${id}/generate-voiceover`, { method: 'POST', body: JSON.stringify(options ?? {}) }),
    regenerateSegment: (id: string, stepIndex: number, text?: string, voiceId?: string): Promise<{ stepIndex: number; audioUrl: string; text: string }> =>
      request(`/runs/${id}/regenerate-segment`, { method: 'POST', body: JSON.stringify({ stepIndex, text, voiceId }) }),
    updateSegmentTiming: (id: string, segments: { stepIndex: number; startTime: number; endTime: number }[]): Promise<unknown> =>
      request(`/runs/${id}/voiceover-segments`, { method: 'PUT', body: JSON.stringify({ segments }) }),
    trimVideo: (id: string, startTime: number, endTime: number): Promise<{ videoPath: string; videoUrl: string }> =>
      request(`/runs/${id}/trim-video`, { method: 'POST', body: JSON.stringify({ startTime, endTime }) }),
    analyzeTry: (id: string, pageContent: string, pageTitle: string, pageId: string): Promise<TryDocReportDTO> =>
      request(`/runs/${id}/analyze-try`, { method: 'POST', body: JSON.stringify({ pageContent, pageTitle, pageId }) }),
    steps: (id: string): Promise<RunStepDTO[]> => request(`/runs/${id}/steps`),
    questions: (id: string): Promise<QuestionDTO[]> => request(`/runs/${id}/questions`),
    doc: (id: string): Promise<GeneratedDocDTO> => request(`/runs/${id}/doc`),
  },
  questions: {
    answer: (runId: string, qid: string, answer: string): Promise<QuestionDTO> =>
      request(`/runs/${runId}/questions/${qid}/answer`, {
        method: 'POST',
        body: JSON.stringify({ answer }),
      }),
  },
  chat: {
    send: (projectId: string, message: string, history: { role: 'user' | 'assistant'; content: string }[], sessionToken?: string): Promise<ChatResponseDTO> =>
      request(`/projects/${projectId}/chat`, { method: 'POST', body: JSON.stringify({ message, history, sessionToken }) }),
    index: (projectId: string, force?: boolean): Promise<{ indexed: number }> =>
      request(`/projects/${projectId}/chat/index`, { method: 'POST', body: JSON.stringify({ force }) }),
    suggestions: (projectId: string): Promise<{ suggestions: string[] }> =>
      request(`/projects/${projectId}/chat/suggestions`),
  },
}

export interface ChatResponseDTO {
  answer: string
  sources: { pageId: string; pageTitle: string; pageSlug: string }[]
  followUps: string[]
}

export interface PreflightCheckDTO {
  category: 'url' | 'credentials' | 'file' | 'navigation' | 'prerequisite'
  label: string
  status: 'ready' | 'missing' | 'warning'
  detail: string
  resolution: string | null
}

export interface PreflightResultDTO {
  ready: boolean
  testPlan: string
  estimatedSteps: number
  checks: PreflightCheckDTO[]
}

export interface TryDocReportDTO {
  version: number
  pageId: string
  pageTitle: string
  executedAt: string
  summary: { totalSteps: number; passed: number; failed: number; ambiguous: number; overallVerdict: 'pass' | 'fail' | 'partial' }
  steps: { stepIndex: number; instruction: string; action: string; pageUrl: string | null; status: 'pass' | 'fail' | 'ambiguous'; issueType: 'doc' | 'product' | null; detail: string; screenshotPath: string | null }[]
  failures: { stepIndex: number | null; issueType: 'doc' | 'product'; title: string; description: string; severity: 'critical' | 'major' | 'minor'; suggestion: string }[]
  docIssues: { clarityScore: number; missingSections: string[]; ambiguousInstructions: string[]; implicitAssumptions: string[] }
  uxInsights: { category: string; description: string; stepIndex: number | null; severity: 'high' | 'medium' | 'low' }[]
  recommendations: { type: 'fix-doc' | 'fix-product' | 'improve-ux'; title: string; description: string; priority: 'high' | 'medium' | 'low' }[]
  scores: { docQuality: number; testPassRate: number; uxClarity: number }
}
