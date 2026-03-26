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
  type: 'step' | 'status' | 'done' | 'error' | 'blocked' | 'close' | 'live'
  step?: { type: string; action: string | null; pageUrl: string | null; reasoning: string | null }
  liveUrl?: string
  stepIndex?: number
  message?: string
  completed?: boolean
}

export interface ProjectDTO {
  id: string
  userId: string
  name: string
  baseUrl: string
  description: string | null
  context: string | null
  createdAt: string
  updatedAt: string
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
  status: 'draft' | 'exploring' | 'published'
  sortOrder: number
  createdAt: string
  updatedAt: string
  children?: DocPageDTO[]
}

export const api = {
  projects: {
    list: (): Promise<ProjectDTO[]> => request('/projects'),
    get: (id: string): Promise<ProjectDTO> => request(`/projects/${id}`),
    create: (body: { name: string; baseUrl: string; description?: string; context?: string; credentials?: { label: string; username: string; password: string }[] }): Promise<ProjectDTO> =>
      request('/projects', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Record<string, unknown>): Promise<ProjectDTO> =>
      request(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string): Promise<void> => request(`/projects/${id}`, { method: 'DELETE' }),
  },
  pages: {
    list: (projectId: string): Promise<DocPageDTO[]> => request(`/projects/${projectId}/pages`),
    get: (projectId: string, pageId: string): Promise<DocPageDTO> =>
      request(`/projects/${projectId}/pages/${pageId}`),
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
    autoGenerate: (projectId: string): Promise<DocPageDTO[]> =>
      request(`/projects/${projectId}/pages/auto-generate`, { method: 'POST' }),
    reorder: (projectId: string, items: { id: string; parentId: string | null; sortOrder: number }[]): Promise<void> =>
      request(`/projects/${projectId}/pages/reorder`, { method: 'PUT', body: JSON.stringify(items) }),
  },
  runs: {
    list: (): Promise<RunDTO[]> => request('/runs'),
    get: (id: string): Promise<RunDTO> => request(`/runs/${id}`),
    create: (body: { featureName: string; startUrl: string; goal: string; docPageId?: string }): Promise<RunDTO> =>
      request('/runs', { method: 'POST', body: JSON.stringify(body) }),
    exploreStream: async (
      id: string,
      onEvent: (event: StepEventDTO) => void,
      context?: string,
    ): Promise<void> => {
      const token = await getAuthToken()
      const params = new URLSearchParams()
      if (context) params.set('context', context)

      const res = await fetch(
        `${API_BASE}/runs/${id}/explore${params.toString() ? `?${params}` : ''}`,
        {
          headers: { Authorization: `Bearer ${token}` },
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
    generateDoc: (id: string): Promise<GeneratedDocDTO> =>
      request(`/runs/${id}/generate-doc`, { method: 'POST' }),
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
}
