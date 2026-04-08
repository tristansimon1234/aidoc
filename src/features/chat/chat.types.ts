export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface UserContext {
  name?: string
  email?: string
  plan?: string
  extra?: string
}

export interface ChatRequest {
  message: string
  history: ChatMessage[]
  userContext?: UserContext
}

export interface DocChunk {
  id: string
  pageId: string
  pageTitle: string
  pageSlug: string
  chunkIndex: number
  chunkText: string
  similarity: number
}

export interface ChatResponse {
  answer: string
  sources: { pageId: string; pageTitle: string; pageSlug: string }[]
  followUps: string[]
}
