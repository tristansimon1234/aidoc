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
  userContext?: { name?: string; email?: string; plan?: string; extra?: string },
): Promise<ChatResponse> {
  // 1. Embed the user query
  const queryEmbedding = await embedText(message)

  // 2. Search for relevant chunks
  const chunks = await chatRepo.searchChunks(projectId, queryEmbedding, 10, 0.25)

  // 3. Fetch project context (name, description, knowledge base)
  const { findProjectById } = await import('../project/project.repository.js')
  const project = await findProjectById(projectId)

  const productContext: string[] = []
  if (project) {
    productContext.push(`Product: ${project.name}`)
    if (project.description) productContext.push(`Description: ${project.description}`)
    if (project.context?.audience) productContext.push(`Target audience: ${project.context.audience}`)
    if (project.context?.workflow) productContext.push(`Core workflow: ${project.context.workflow}`)
    if (project.context?.quirks) productContext.push(`Important details: ${project.context.quirks}`)
    if (project.discoveredContext?.summary) productContext.push(`Product summary: ${project.discoveredContext.summary}`)
    if (project.discoveredContext?.features?.length) {
      productContext.push(`Key features: ${project.discoveredContext.features.join(', ')}`)
    }
    if (project.discoveredContext?.terminology && Object.keys(project.discoveredContext.terminology).length > 0) {
      const terms = Object.entries(project.discoveredContext.terminology)
        .map(([term, def]) => `${term}: ${def}`)
        .join('; ')
      productContext.push(`Terminology: ${terms}`)
    }
  }

  if (chunks.length === 0) {
    return {
      answer: productContext.length > 0
        ? "I don't have a specific article about that, but I'd be happy to help! Could you rephrase your question or ask about a specific feature?"
        : "I couldn't find relevant information to answer your question. The documentation may not cover this topic yet.",
      sources: [],
    }
  }

  // 4. Build context from chunks
  const context = buildContextFromChunks(chunks)

  // 5. Build conversation with history
  const conversationHistory = history
    .slice(-10)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')

  // Build user context block
  const userInfo: string[] = []
  if (userContext?.name) userInfo.push(`Name: ${userContext.name}`)
  if (userContext?.email) userInfo.push(`Email: ${userContext.email}`)
  if (userContext?.plan) userInfo.push(`Plan: ${userContext.plan}`)
  if (userContext?.extra) userInfo.push(`Additional context: ${userContext.extra}`)

  const userContextBlock = userInfo.length > 0
    ? `\n\n## About the user you're helping\n${userInfo.join('\n')}\nAddress them by first name if known. Tailor answers to their plan/context when relevant.`
    : ''

  const productBlock = productContext.length > 0
    ? `\n\n## Product Knowledge\n${productContext.join('\n')}`
    : ''

  const systemPrompt = `You are a friendly, knowledgeable support assistant for a software product. You help users understand features, solve problems, and get the most out of the product.${productBlock}${userContextBlock}

## Your personality
- Warm and welcoming — like a helpful colleague, not a cold bot
- Patient and didactic — explain step by step, assume the user might be new
- Proactive — if you notice the user might benefit from a related tip or feature, mention it briefly
- Honest — if you don't know something or the docs don't cover it, say so kindly and suggest what the user could try

## How to answer
- Start with a direct answer to the question, then provide details
- Use numbered steps when explaining a process (1, 2, 3...)
- If the documentation includes screenshots, include the most relevant ones to illustrate (use the exact markdown image syntax from the context)
- Use simple language — avoid jargon unless the user uses it first
- Match the language of the user's question (if they write in French, answer in French)
- Keep answers focused but complete — don't make the user ask follow-ups for basic info

## Boundaries
- Base your answers on the documentation context provided — don't invent features
- Do NOT invent or fabricate screenshot URLs — only use images from the context
- If the docs don't cover something, say: "I don't have specific info about that in the documentation, but here's what I'd suggest..."
- For complex issues beyond the docs, suggest contacting the support team`

  const userPrompt = `## Documentation Context

${context}

${conversationHistory ? `## Conversation History\n\n${conversationHistory}\n\n` : ''}## User's Question

${message}`

  const response = await generateText({
    systemPrompt,
    userPrompt,
    maxTokens: 2048,
  })

  // Deduplicate sources
  const sourceMap = new Map<string, { pageId: string; pageTitle: string; pageSlug: string }>()
  for (const chunk of chunks) {
    if (!sourceMap.has(chunk.pageSlug)) {
      sourceMap.set(chunk.pageSlug, { pageId: chunk.pageId, pageTitle: chunk.pageTitle, pageSlug: chunk.pageSlug })
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
