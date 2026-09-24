// Types partagés par les deux stockages (Supabase et local).

export type SopStatus = 'uploading' | 'processing' | 'ready' | 'failed'
/** « none », « gemini:<nom> » ou « elevenlabs:<id> » (voir server/voices.ts). */
export type Voice = string

export type SopKind = 'sop' | 'marketing'

export interface Sop {
  id: string
  userId: string
  title: string
  language: string
  voice: Voice
  /** Ton de la voix off (voir TONES dans prompts.ts). */
  tone: string
  /** « sop » (procédure + vidéo commentée) ou « marketing » (vidéo promo courte). */
  kind: SopKind
  /** Vidéo marketing : ce qu'il faut mettre en avant, durée visée (30 ou 60 s), musique de fond. */
  brief: string | null
  targetSeconds: number
  music: boolean
  status: SopStatus
  progress: string | null
  error: string | null
  creditsUsed: number
  sourcePath: string
  durationSeconds: number | null
  markdown: string | null
  videoPath: string | null
  createdAt: string
  updatedAt: string
}

export interface Account {
  credits: number
  stripeCustomerId: string | null
}

export type SopPatch = Partial<{
  status: SopStatus
  progress: string | null
  error: string | null
  creditsUsed: number
  durationSeconds: number
  markdown: string
  videoPath: string
}>
