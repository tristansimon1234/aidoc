export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  message: string
  history: ChatMessage[]
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
}
