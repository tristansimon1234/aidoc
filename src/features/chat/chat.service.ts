import { embedText, embedTexts, generateText } from '../../shared/ai/gemini.client.js'
import * as chatRepo from './chat.repository.js'
import type { ChatMessage, ChatResponse, DocChunk } from './chat.types.js'

// --- Chunking ---

const CHUNK_SIZE = 500 // ~500 tokens per chunk
const CHUNK_OVERLAP = 50

export function chunkMarkdown(markdown: string): string[] {
  if (!markdown.trim()) return []

  // Split on headings first for semantic boundaries
  const sections = markdown.split(/(?=^#{1,3}\s)/m).filter((s) => s.trim())

  const chunks: string[] = []
  for (const section of sections) {
    if (section.length <= CHUNK_SIZE) {
      chunks.push(section.trim())
    } else {
      // Split long sections into overlapping chunks by paragraphs
      const paragraphs = section.split(/\n\n+/)
      let current = ''
      for (const para of paragraphs) {
        if (current.length + para.length > CHUNK_SIZE && current) {
          chunks.push(current.trim())
          // Keep overlap from end of previous chunk
          const words = current.split(/\s+/)
          current = words.slice(-CHUNK_OVERLAP).join(' ') + '\n\n' + para
        } else {
          current += (current ? '\n\n' : '') + para
        }
      }
      if (current.trim()) chunks.push(current.trim())
    }
  }
  return chunks
}

// --- Indexing ---

export async function indexPage(page: {
  id: string
  projectId: string
  title: string
  slug: string
  content: string | null
}): Promise<number> {
  // Clear old embeddings for this page
  await chatRepo.deleteEmbeddingsByPageId(page.id)

  if (!page.content?.trim()) return 0

  const chunks = chunkMarkdown(page.content)
  if (chunks.length === 0) return 0

  // Embed all chunks
  const embeddings = await embedTexts(chunks)

  // Store in DB
  await chatRepo.insertEmbeddings(
    chunks.map((text, i) => ({
      projectId: page.projectId,
      pageId: page.id,
      chunkIndex: i,
      chunkText: text,
      embedding: embeddings[i]!,
      pageTitle: page.title,
      pageSlug: page.slug,
    })),
  )

  console.log(`[chat] Indexed ${chunks.length} chunks for "${page.title}"`)
  return chunks.length
}

export async function indexProject(projectId: string): Promise<number> {
  const { findPagesByProjectId } = await import('../page/page.repository.js')
  const pages = await findPagesByProjectId(projectId)

  let total = 0
  for (const page of pages) {
    if (page.content?.trim()) {
      total += await indexPage({
        id: page.id,
        projectId: page.projectId,
        title: page.title,
        slug: page.slug,
        content: page.content,
      })
    }
  }
  console.log(`[chat] Indexed ${total} total chunks for project ${projectId}`)
  return total
}

// --- RAG Chat ---

export async function chat(
  projectId: string,
  message: string,
  history: ChatMessage[],
): Promise<ChatResponse> {
  // 1. Embed the user query
  const queryEmbedding = await embedText(message)

  // 2. Search for relevant chunks
  const chunks = await chatRepo.searchChunks(projectId, queryEmbedding, 10, 0.25)

  if (chunks.length === 0) {
    return {
      answer: "I couldn't find relevant information in the documentation to answer your question. The documentation may not cover this topic yet.",
      sources: [],
    }
  }

  // 3. Build context from chunks
  const context = buildContextFromChunks(chunks)

  // 4. Build conversation with history
  const conversationHistory = history
    .slice(-10) // last 10 messages max
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')

  const systemPrompt = `You are a helpful assistant that answers questions based on product documentation.

Rules:
- ONLY answer based on the provided documentation context
- If the documentation doesn't cover something, say so honestly
- Reference specific pages when relevant using [Page Title](/slug) format
- Be concise and direct
- Use the same language as the documentation
- If the user asks something unrelated to the product, politely redirect to the documentation topics`

  const userPrompt = `## Documentation Context

${context}

${conversationHistory ? `## Conversation History\n\n${conversationHistory}\n\n` : ''}## Current Question

${message}`

  const response = await generateText({
    systemPrompt,
    userPrompt,
    maxTokens: 2048,
  })

  // Deduplicate sources
  const sourceMap = new Map<string, { pageTitle: string; pageSlug: string }>()
  for (const chunk of chunks) {
    if (!sourceMap.has(chunk.pageSlug)) {
      sourceMap.set(chunk.pageSlug, { pageTitle: chunk.pageTitle, pageSlug: chunk.pageSlug })
    }
  }

  return {
    answer: response.text,
    sources: Array.from(sourceMap.values()),
  }
}

function buildContextFromChunks(chunks: DocChunk[]): string {
  // Group chunks by page for coherent context
  const byPage = new Map<string, DocChunk[]>()
  for (const chunk of chunks) {
    const existing = byPage.get(chunk.pageSlug) ?? []
    existing.push(chunk)
    byPage.set(chunk.pageSlug, existing)
  }

  const sections: string[] = []
  for (const [slug, pageChunks] of byPage) {
    const title = pageChunks[0]!.pageTitle
    // Sort by chunk index for reading order
    pageChunks.sort((a, b) => a.chunkIndex - b.chunkIndex)
    const text = pageChunks.map((c) => c.chunkText).join('\n\n')
    sections.push(`### From "${title}" (/${slug})\n\n${text}`)
  }

  return sections.join('\n\n---\n\n')
}
