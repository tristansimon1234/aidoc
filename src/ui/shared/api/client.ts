import { supabase } from './supabase.js'

const API_BASE = '/api'

/** Error thrown by `request()` that preserves the backend's machine-readable
 *  `code` (e.g. "QUOTA_EXCEEDED") and the HTTP `status`, so UI code can
 *  branch on them without fragile string matching. */
export class ApiError extends Error {
  readonly code: string | null
  readonly status: number
  constructor(message: string, code: string | null, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export function isQuotaError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === 'QUOTA_EXCEEDED'
}

/** Active team id, persisted in localStorage. Set by AcceptInvite when the
 *  user joins someone else's workspace; read by request() below to attach an
 *  X-Team-Id header. In the single-workspace model there's usually only the
 *  personal team, so this stays null for most users. */
const ACTIVE_TEAM_KEY = 'aidoc_active_team_id'

export function getActiveTeamId(): string | null {
  try { return localStorage.getItem(ACTIVE_TEAM_KEY) }
  catch { return null }
}

export function setActiveTeamId(teamId: string | null): void {
  try {
    if (teamId) localStorage.setItem(ACTIVE_TEAM_KEY, teamId)
    else localStorage.removeItem(ACTIVE_TEAM_KEY)
  } catch { /* no-op */ }
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  const teamId = getActiveTeamId()
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(teamId ? { 'X-Team-Id': teamId } : {}),
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
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null
    throw new ApiError(
      body?.error ?? `Request failed: ${res.status}`,
      body?.code ?? null,
      res.status,
    )
  }

  // 204 No Content (or empty body) — callers that type T as void just ignore
  // the returned null. Prevents "Unexpected end of JSON input" on DELETE.
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return null as unknown as T
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

export type MarketingRenderStatusDTO = 'idle' | 'rendering' | 'ready' | 'failed'

export interface MarketingSceneDTO {
  voiceover: string
  headline: string
  subhead?: string
  screenshotIndex: number | null
  durationSeconds: number
}

export interface MarketingScriptDTO {
  hook: { voiceover: string; headline: string; durationSeconds: number }
  scenes: MarketingSceneDTO[]
  cta: { voiceover: string; headline: string; buttonLabel: string; durationSeconds: number }
  totalDurationSeconds: number
  language: string
}

export interface MarketingManifestDTO {
  runId: string
  generatedAt: string
  script: MarketingScriptDTO
  screenshots: { url: string; caption: string }[]
  branding: {
    productName: string
    accentColor: string
    bgColor: string
    textColor: string
    fontFamily: string
    logoUrl: string | null
  }
  voiceoverUrl: string | null
  voiceoverPath: string | null
}

export interface MarketingVideoSummaryDTO {
  manifest: MarketingManifestDTO
  manifestUrl: string | null
  videoUrl: string | null
  videoPath: string | null
  renderStatus: MarketingRenderStatusDTO
  renderError: string | null
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
  teamId: string
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
  publicDocsChatEnabled: boolean
  archivedAt: string | null
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

export type PlanId = 'free' | 'founder' | 'team' | 'agency'

export interface PlanDTO {
  id: PlanId
  name: string
  priceCents: number
  currency: string
  stripePriceId: string | null
  monthlyTokens: number
  /** Total seats (owner + members + pending invites) the plan allows. */
  maxMembers: number
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
  allowed: boolean
  overageEnabled: boolean
}

export interface BillingSummaryDTO {
  plan: PlanDTO
  subscription: SubscriptionDTO
  usage: UsageSnapshotDTO
  team: { id: string; name: string; personal: boolean }
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
  overageEur: number
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
  /** Lossless BlockNote document; null means "parse from `content`". */
  contentBlocks: unknown
  /** Snapshot of the content replaced by the most recent destructive
   *  regeneration. Null when nothing to undo. */
  previousContent?: string | null
  previousContentBlocks?: unknown
  previousContentSavedAt?: string | null
  customPrompt: string | null
  briefing: PageBriefingDTO | null
  status: 'draft' | 'exploring' | 'published'
  isPublic: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
  createdBy: string | null
  lastEditedBy: string | null
  lastEditedAt: string | null
  /** Set on single-page GET only; list/tree skip the profile lookup. */
  lastEditedByName?: string | null
  createdByName?: string | null
  children?: DocPageDTO[]
}

export interface ImportResultDTO {
  projectId: string
  createdPageIds: string[]
  skippedSlugs: string[]
  mediaReuploaded: number
  warnings: string[]
}

export type ActivityKindDTO = 'page_edited' | 'doc_generated' | 'member_joined' | 'page_published'

export interface ActivityItemDTO {
  kind: ActivityKindDTO
  at: string
  actorName: string | null
  subject: string
  href?: string
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
    activity: (id: string): Promise<{ items: ActivityItemDTO[] }> => request(`/projects/${id}/activity`),
    create: (body: { name: string; baseUrl: string; description?: string; context?: ProjectContextDTO; credentials?: { label: string; username: string; password: string }[] }): Promise<ProjectDTO> =>
      request('/projects', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Record<string, unknown>): Promise<ProjectDTO> =>
      request(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string): Promise<void> => request(`/projects/${id}`, { method: 'DELETE' }),
    transfer: (id: string, teamId: string): Promise<ProjectDTO> =>
      request(`/projects/${id}/transfer`, { method: 'POST', body: JSON.stringify({ teamId }) }),
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
    /** Triggers a browser download of the project as a ZIP. Uses a blob
     *  fetch (rather than a plain `<a download>`) so the auth header is
     *  attached — the endpoint is authed and a bare link would 401. */
    exportZip: async (id: string): Promise<void> => {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      const teamId = getActiveTeamId()
      const res = await fetch(`${API_BASE}/projects/${id}/export`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(teamId ? { 'X-Team-Id': teamId } : {}),
        },
      })
      if (!res.ok) throw new ApiError(`Export failed (${res.status})`, null, res.status)
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const match = /filename="([^"]+)"/.exec(disposition)
      const filename = match?.[1] ?? 'doclee-export.zip'
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    },
    importZip: async (id: string, file: File): Promise<ImportResultDTO> => {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      const teamId = getActiveTeamId()
      const res = await fetch(`${API_BASE}/projects/${id}/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(teamId ? { 'X-Team-Id': teamId } : {}),
        },
        body: file,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null
        throw new ApiError(body?.error ?? `Import failed (${res.status})`, body?.code ?? null, res.status)
      }
      return res.json() as Promise<ImportResultDTO>
    },
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
    restorePrevious: (projectId: string, pageId: string): Promise<DocPageDTO> =>
      request(`/projects/${projectId}/pages/${pageId}/restore-previous`, { method: 'POST' }),
    doc: (projectId: string, pageId: string): Promise<GeneratedDocDTO> =>
      request(`/projects/${projectId}/pages/${pageId}/doc`),
    latestRun: (projectId: string, pageId: string): Promise<RunDTO | null> =>
      request<RunDTO>(`/projects/${projectId}/pages/${pageId}/run`).catch(() => null),
    reorder: (projectId: string, items: { id: string; parentId: string | null; sortOrder: number }[]): Promise<void> =>
      request(`/projects/${projectId}/pages/reorder`, { method: 'PUT', body: JSON.stringify(items) }),
    preflight: (projectId: string, pageId: string): Promise<PreflightResultDTO> =>
      request(`/projects/${projectId}/pages/${pageId}/preflight`, { method: 'POST' }),
    exportZip: async (projectId: string, pageId: string): Promise<void> => {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      const teamId = getActiveTeamId()
      const res = await fetch(`${API_BASE}/projects/${projectId}/pages/${pageId}/export`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(teamId ? { 'X-Team-Id': teamId } : {}),
        },
      })
      if (!res.ok) throw new ApiError(`Export failed (${res.status})`, null, res.status)
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const match = /filename="([^"]+)"/.exec(disposition)
      const filename = match?.[1] ?? 'page.zip'
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    },
    importZip: async (projectId: string, file: File, parentId?: string): Promise<ImportResultDTO> => {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      const teamId = getActiveTeamId()
      const qs = parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''
      const res = await fetch(`${API_BASE}/projects/${projectId}/pages/import${qs}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(teamId ? { 'X-Team-Id': teamId } : {}),
        },
        body: file,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null
        throw new ApiError(body?.error ?? `Import failed (${res.status})`, body?.code ?? null, res.status)
      }
      return res.json() as Promise<ImportResultDTO>
    },
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
    attachVideo: (id: string, videoPath: string): Promise<{ ok: true }> =>
      request(`/runs/${id}/attach-video`, { method: 'POST', body: JSON.stringify({ videoPath }) }),
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
    marketingVideo: {
      get: (id: string): Promise<MarketingVideoSummaryDTO | null> =>
        request<MarketingVideoSummaryDTO>(`/runs/${id}/marketing-video`).catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) return null
          throw err
        }),
      generate: (
        id: string,
        opts?: { userPrompt?: string; withVoiceover?: boolean; voiceId?: string },
      ): Promise<MarketingVideoSummaryDTO> =>
        request(`/runs/${id}/marketing-video`, {
          method: 'POST',
          body: JSON.stringify(opts ?? {}),
        }),
      render: (id: string): Promise<MarketingVideoSummaryDTO> =>
        request(`/runs/${id}/marketing-video/render`, { method: 'POST' }),
    },
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
  analytics: {
    report: (projectId: string, period: AnalyticsPeriodDTO): Promise<AnalyticsReportDTO> =>
      request(`/projects/${projectId}/analytics?period=${period}`),
    recommendations: (projectId: string, period: AnalyticsPeriodDTO): Promise<AnalyticsRecommendationsDTO> =>
      request(`/projects/${projectId}/analytics/recommendations?period=${period}`, { method: 'POST' }),
  },
  teams: {
    list: (): Promise<{ team: TeamDTO; role: TeamRoleDTO }[]> => request('/teams'),
    create: (name: string): Promise<TeamDTO> =>
      request('/teams', { method: 'POST', body: JSON.stringify({ name }) }),
    get: (teamId: string): Promise<{ team: TeamDTO; members: TeamMemberDTO[]; role: TeamRoleDTO; seats: TeamSeatInfoDTO; pendingInvites: TeamInviteDTO[] }> =>
      request(`/teams/${teamId}`),
    cancelInvite: (teamId: string, inviteId: string): Promise<void> =>
      request(`/teams/${teamId}/invites/${inviteId}`, { method: 'DELETE' }),
    rename: (teamId: string, name: string): Promise<TeamDTO> =>
      request(`/teams/${teamId}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    delete: (teamId: string): Promise<void> =>
      request(`/teams/${teamId}`, { method: 'DELETE' }),
    invite: (teamId: string, email: string, role: TeamRoleDTO = 'member'): Promise<{ inviteId: string; acceptUrl: string; emailSent: boolean }> =>
      request(`/teams/${teamId}/members/invite`, { method: 'POST', body: JSON.stringify({ email, role }) }),
    removeMember: (teamId: string, userId: string): Promise<void> =>
      request(`/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),
    changeRole: (teamId: string, userId: string, role: TeamRoleDTO): Promise<void> =>
      request(`/teams/${teamId}/members/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    acceptInvite: (token: string): Promise<{ teamId: string }> =>
      request(`/teams/invites/${token}/accept`, { method: 'POST' }),
  },
  invites: {
    peek: (token: string): Promise<{ teamName: string; email: string; inviterName: string | null; expiresAt: string; accepted: boolean }> =>
      request(`/invites/${token}`),
  },
  mcpTokens: {
    list: (): Promise<McpTokenSummaryDTO[]> => request('/mcp-tokens'),
    create: (body: {
      name: string
      teamId: string
      scope?: McpScopeDTO
      expiresInDays?: number
    }): Promise<McpTokenCreatedDTO> =>
      request('/mcp-tokens', { method: 'POST', body: JSON.stringify(body) }),
    rotate: (id: string): Promise<McpTokenRotatedDTO> =>
      request(`/mcp-tokens/${id}/rotate`, { method: 'POST' }),
    revoke: (id: string): Promise<void> =>
      request(`/mcp-tokens/${id}`, { method: 'DELETE' }),
  },
}

export type McpScopeDTO = 'read' | 'write' | 'admin'

export interface McpTokenSummaryDTO {
  id: string
  userId: string
  teamId: string
  name: string
  preview: string
  scope: McpScopeDTO
  lastUsedAt: string | null
  lastUsedIp: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

/** Returned once on create. `token` is the full secret — the UI must display
 *  it immediately and then drop it from state; subsequent list calls only
 *  return the preview. */
export interface McpTokenCreatedDTO extends McpTokenSummaryDTO {
  token: string
}

/** Returned by the rotate endpoint — same shape as create plus the grace
 *  window during which the old token still works. */
export interface McpTokenRotatedDTO extends McpTokenCreatedDTO {
  rotatedFromId: string
  oldTokenValidUntil: string
}

export type TeamRoleDTO = 'owner' | 'member'

export interface TeamDTO {
  id: string
  name: string
  slug: string
  personal: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface TeamMemberDTO {
  teamId: string
  userId: string
  email: string | null
  fullName: string | null
  role: TeamRoleDTO
  joinedAt: string
}

export interface TeamSeatInfoDTO {
  used: number       // active members + pending invites
  max: number        // from the team's plan
  planName: string
  allowed: boolean   // false when used >= max — UI disables the invite form
}

export interface TeamInviteDTO {
  id: string
  email: string
  role: TeamRoleDTO
  createdAt: string
  expiresAt: string
}

export type AnalyticsPeriodDTO = '7d' | '30d' | '90d'
export type AnalyticsChatSourceDTO = 'widget' | 'public' | 'app'
export type AnalyticsMessageCategoryDTO = 'onboarding' | 'pricing' | 'how-to' | 'error' | 'integration' | 'account' | 'other'

export interface AnalyticsReportDTO {
  periodStart: string
  periodEnd: string
  period: AnalyticsPeriodDTO
  chatStats: {
    totalSessions: number
    totalMessages: number
    userMessages: number
    assistantMessages: number
    avgMessagesPerSession: number
    bySource: Record<AnalyticsChatSourceDTO, { sessions: number; messages: number }>
    sentimentCounts: {
      positive: number
      negative: number
      frustrated: number
      classified: number
    }
  }
  viewStats: {
    totalViews: number
    uniqueSessions: number
    topPages: { slug: string; title: string | null; views: number }[]
  }
  painPoints: {
    category: AnalyticsMessageCategoryDTO
    total: number
    negative: number
    frustrated: number
    examples: string[]
  }[]
  frustrationSignals: {
    content: string
    source: AnalyticsChatSourceDTO
    createdAt: string
    category: AnalyticsMessageCategoryDTO | null
  }[]
  recentSamples: {
    role: 'user' | 'assistant'
    content: string
    source: AnalyticsChatSourceDTO
    createdAt: string
    sentiment: 'positive' | 'neutral' | 'negative' | null
    frustrationFlag: boolean
    language: string | null
    category: AnalyticsMessageCategoryDTO | null
  }[]
}

export interface AnalyticsRecommendationsDTO {
  generatedAt: string
  summary: string
  items: {
    type: 'content' | 'product' | 'ux'
    title: string
    description: string
    priority: 'high' | 'medium' | 'low'
  }[]
}

export interface ChatResponseDTO {
  answer: string
  sources: { pageId: string; pageTitle: string; pageSlug: string }[]
  followUps: string[]
  /** Set when the answer describes concrete UI actions (click / type /
   *  navigate). UI can use it to show a "Guide me" button or embed a
   *  matching video clip. */
  walkthroughAvailable?: boolean
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
