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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = await getAuthHeaders()
  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  })

  if (res.status === 401) {
    // Session expired — sign out and reload
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

export interface ExplorationResultDTO {
  completed: boolean
  message: string
  actions: Record<string, unknown>[]
  needsQuestion: boolean
  question: string | null
}

export const api = {
  runs: {
    list: (): Promise<RunDTO[]> => request('/runs'),
    get: (id: string): Promise<RunDTO> => request(`/runs/${id}`),
    create: (body: { featureName: string; startUrl: string; goal: string }): Promise<RunDTO> =>
      request('/runs', { method: 'POST', body: JSON.stringify(body) }),
    explore: (id: string, context?: string): Promise<ExplorationResultDTO> =>
      request(`/runs/${id}/explore`, {
        method: 'POST',
        body: JSON.stringify(context ? { context } : {}),
      }),
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
