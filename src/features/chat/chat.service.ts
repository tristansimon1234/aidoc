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
  userContext?: { name?: string; email?: string; plan?: string; extra?: string; currentUrl?: string },
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
      followUps: [],
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
  if (userContext?.currentUrl) userInfo.push(`Currently viewing: ${userContext.currentUrl}`)
  if (userContext?.extra) userInfo.push(`Additional context: ${userContext.extra}`)

  const userContextBlock = userInfo.length > 0
    ? `\n\n## About the user you're helping\n${userInfo.join('\n')}\nAddress them by first name if known. Tailor answers to their plan/context when relevant. If you know which page they're currently viewing, prioritize help related to that page and make your follow-up suggestions relevant to where they are in the app.`
    : ''

  const productBlock = productContext.length > 0
    ? `\n\n## Product Knowledge\n${productContext.join('\n')}`
    : ''

  const systemPrompt = `You are a friendly, knowledgeable support assistant for a software product.${productBlock}${userContextBlock}

## Your personality
- Warm, natural, conversational — like a smart colleague helping out
- You KNOW this product inside out — be confident, not robotic
- Proactive — suggest things the user hasn't asked about yet if relevant

## How to answer — THIS IS CRITICAL
- Be concise. Short sentences. No walls of text.
- For simple questions: answer in 2-3 sentences max
- For "how do I..." questions: give the FIRST 2-3 steps only, then say something like "Want me to continue with the next steps?" or "Should I walk you through the rest?"
- NEVER dump a full 10-step tutorial in one message. Break it into chunks of 2-3 steps and wait for the user to ask for more.
- If the user says "yes", "continue", "go on" → give the next 2-3 steps
- Include ONE relevant screenshot per message if available — not more
- Match the user's language (French → French, English → English)

## Follow-up suggestions
- After your answer, add a line "---FOLLOWUPS---" then a JSON array of 1-2 short follow-up questions
- These must be specific to what was just discussed — not generic
- Example format:
  ---FOLLOWUPS---
  ["How do I invite team members?", "What are the different plans?"]
- ALWAYS include the ---FOLLOWUPS--- separator and array, even if it's just one question

## Boundaries
- Base your answers on the documentation context — don't invent features
- Do NOT fabricate screenshot URLs — only use images that appear in the context
- If the docs don't cover something, say so briefly and suggest what to try
- For complex issues beyond the docs, suggest contacting support`

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

  // Parse follow-ups from response
  let answer = response.text
  let followUps: string[] = []
  // Match various formats Gemini might use: ---FOLLOWUPS---, FOLLOWUPS, ---FOLLOWUPS, etc.
  const followUpSplit = answer.split(/---?\s*FOLLOWUPS\s*---?/i)
  if (followUpSplit.length > 1) {
    answer = followUpSplit[0]!.trim()
    try {
      let jsonStr = followUpSplit[1]!.trim()
      if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const parsed = JSON.parse(jsonStr) as string[]
      if (Array.isArray(parsed)) followUps = parsed.slice(0, 2)
    } catch { /* keep empty */ }
  }

  return {
    answer,
    sources: Array.from(sourceMap.values()),
    followUps,
  }
}

export async function getSuggestions(projectId: string): Promise<string[]> {
  const { findProjectById } = await import('../project/project.repository.js')
  const project = await findProjectById(projectId)
  if (!project) return []

  const { findPagesByProjectId } = await import('../page/page.repository.js')
  const pages = await findPagesByProjectId(projectId)
  const publishedPages = pages.filter((p) => p.content?.trim())

  if (publishedPages.length === 0) return []

  const pageTitles = publishedPages.map((p) => p.title).join(', ')
  const features = project.discoveredContext?.features?.join(', ') || ''

  const audience = project.context?.audience || ''
  const workflow = project.context?.workflow || ''
  const summary = project.discoveredContext?.summary || ''

  const response = await generateText({
    systemPrompt: `You are an expert at understanding what users need help with when using a software product. Your job is to generate the most useful, specific questions a real user would ask.

Rules:
- Generate EXACTLY 6 questions
- Each question must be under 60 characters
- Questions must be SPECIFIC to this product — never generic like "How does it work?" or "What are the features?"
- Think about: onboarding friction, common workflows, billing/plan questions, advanced features users discover later, troubleshooting
- Mix different types: how-to, troubleshooting, feature discovery, best practices
- Write in the same language as the product documentation
- Return ONLY a JSON array of 6 strings, nothing else`,
    userPrompt: `Product: ${project.name}
${project.description ? `Description: ${project.description}` : ''}
${audience ? `Target audience: ${audience}` : ''}
${workflow ? `Core workflow: ${workflow}` : ''}
${summary ? `Product summary: ${summary}` : ''}
Documentation pages: ${pageTitles}
${features ? `Key features: ${features}` : ''}

Generate 6 highly specific questions that users of THIS product would actually ask.`,
    maxTokens: 512,
  })

  try {
    let jsonStr = response.text.trim()
    if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const parsed = JSON.parse(jsonStr) as string[]
    return Array.isArray(parsed) ? parsed.slice(0, 6) : []
  } catch {
    return []
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
