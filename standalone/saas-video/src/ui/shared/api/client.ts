import { supabase } from './supabase.js'

const API_BASE = '/api'

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string | null,
    public status: number,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  })

  if (res.status === 204) return undefined as T

  const isJson = res.headers.get('content-type')?.includes('application/json')
  const body = isJson ? await res.json() : await res.text()

  if (!res.ok) {
    const err = isJson ? body : { error: body, code: null }
    throw new ApiError(err.error ?? `Request failed: ${res.status}`, err.code ?? null, res.status, err.details)
  }
  return body as T
}

// ============================================================
// DTOs — keep loose; the backend is the source of truth.
// ============================================================

export interface BrandDTO {
  id: string
  userId: string
  name: string
  logoUrl: string | null
  logoPath: string | null
  accentColor: string
  bgColor: string
  textColor: string
  fontFamily: string
  websiteUrl: string | null
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export interface MarketingVideoListItemDTO {
  id: string
  title: string
  brief: string
  brandId: string
  videoUrl: string | null
  thumbnailUrl: string | null
  renderStatus: 'pending' | 'idle' | 'generating' | 'rendering' | 'ready' | 'failed'
  renderError: string | null
  createdAt: string
  durationSeconds: number | null
}

export type VoiceTone =
  | 'punchy' | 'calm' | 'playful' | 'serious'
  | 'confident' | 'inspirational' | 'conversational'

export interface CreditsDTO {
  balance: number
  totalBought: number
  packs: { id: string; name: string; credits: number; priceCents: number }[]
}

export const api = {
  profile: {
    me: (): Promise<{ id: string; email: string; createdAt: string }> => request('/profile'),
  },
  brands: {
    list: (): Promise<{ items: BrandDTO[] }> => request('/brands'),
    create: (body: Partial<Omit<BrandDTO, 'id' | 'userId' | 'createdAt' | 'updatedAt'>> & { name: string }): Promise<BrandDTO> =>
      request('/brands', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Partial<BrandDTO>): Promise<BrandDTO> =>
      request(`/brands/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string): Promise<void> =>
      request(`/brands/${id}`, { method: 'DELETE' }),
  },
  marketingVideos: {
    list: (): Promise<{ items: MarketingVideoListItemDTO[] }> => request('/marketing-videos'),
    get: (id: string): Promise<MarketingVideoListItemDTO & { manifest: unknown }> =>
      request(`/marketing-videos/${id}`),
    create: (body: {
      brief: string
      title?: string
      brandId?: string
      options?: {
        tone?: VoiceTone
        voiceId?: string
        musicTrackId?: string
        musicVolume?: number
        aiMusicPrompt?: string
        userPrompt?: string
      }
    }): Promise<MarketingVideoListItemDTO> =>
      request('/marketing-videos', { method: 'POST', body: JSON.stringify(body) }),
    delete: (id: string): Promise<void> =>
      request(`/marketing-videos/${id}`, { method: 'DELETE' }),
    voices: (): Promise<{ voices: Array<{ voiceId: string; name: string; category: string }> }> =>
      request('/marketing-videos/_config/voices'),
    musicPresets: (): Promise<{ presets: Array<{ id: string; name: string; mood?: string }> }> =>
      request('/marketing-videos/_config/music-presets'),
  },
  credits: {
    get: (): Promise<CreditsDTO> => request('/credits'),
    checkout: (packId: 'starter' | 'pro' | 'agency'): Promise<{ url: string }> =>
      request('/credits/checkout', { method: 'POST', body: JSON.stringify({ packId }) }),
  },
}
