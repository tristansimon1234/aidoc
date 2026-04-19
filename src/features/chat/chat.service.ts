import { embedText, embedTexts, generateText, GEMINI_PRO_MODEL } from '../../shared/ai/gemini.client.js'
import { buildWalkthroughPrompt, WALKTHROUGH_SYSTEM_PROMPT } from '../../shared/ai/prompt.builder.js'
import { env } from '../../shared/config/env.js'
import { WalkthroughResponseSchema } from './chat.schema.js'
import * as chatRepo from './chat.repository.js'
import type { ChatMessage, ChatResponse, DocChunk } from './chat.types.js'
import type { WalkthroughRequest, WalkthroughResponse } from './walkthrough.types.js'

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

// --- Greeting / small-talk detection ---

function needsDocSearch(message: string, _history: ChatMessage[]): boolean {
  const msg = message.trim().toLowerCase()

  // Short messages that are clearly greetings/acknowledgments
  const SKIP_PATTERNS = [
    /^(hi|hello|hey|coucou|salut|bonjour|bonsoir|yo|sup)\b/,
    /^(merci|thanks?|thank you|thx|ty)\b/,
    /^(ok|okay|oui|yes|yep|yeah|non|no|nope|nah)\b/,
    /^(cool|nice|great|super|parfait|genial|top)\b/,
    /^(bye|goodbye|au revoir|a\+|ciao)\b/,
    /^(lol|haha|mdr|ptdr)\b/,
  ]

  // If message is very short and matches a skip pattern, no search needed
  if (msg.length < 20 && SKIP_PATTERNS.some((p) => p.test(msg))) return false

  // "continue", "go on", "next" — use context from history, no new search
  if (msg.length < 15 && /^(continue|go on|next|suite|la suite|encore|more)\b/.test(msg)) return false

  return true
}

// --- RAG Chat ---

export async function chat(
  projectId: string,
  message: string,
  history: ChatMessage[],
  userContext?: { name?: string; email?: string; plan?: string; extra?: string; currentUrl?: string },
): Promise<ChatResponse> {
  // 1. Embed the user query and search — skip for greetings/small talk.
  //    Rewrite the query to be self-contained when there's history: "and
  //    the other one?" embeds nothing useful on its own but rewrites to
  //    e.g. "What's the second plan option?" given the prior exchange.
  let chunks: DocChunk[] = []
  const didSearch = needsDocSearch(message, history)
  if (didSearch) {
    const effectiveQuery = history.length >= 2
      ? await rewriteQueryWithHistory(message, history).catch(() => message)
      : message
    const queryEmbedding = await embedText(effectiveQuery)
    // Retrieve generously (top-20) at a low threshold (0.15) to maximise
    // recall; the answer-generation prompt tolerates extra context and
    // Gemini's 1M context window means top-20 costs nothing.
    const candidates = await chatRepo.searchChunks(projectId, queryEmbedding, 20, 0.15)
    // Rerank candidates with Gemini as a judge — top-5 by relevance, not
    // just by cosine similarity. Gated: only fire when the extra
    // ~800ms-1.5s buys us something (many candidates to triage AND a
    // question complex enough that cosine rank may be misleading).
    // Short simple questions keep the raw top-8 and stay snappy.
    const shouldRerank = candidates.length >= 12 && effectiveQuery.length >= 40
    chunks = candidates.length > 0
      ? (shouldRerank
          ? await rerankChunks(effectiveQuery, candidates, 5).catch(() => candidates.slice(0, 8))
          : candidates.slice(0, 8))
      : []
  }

  // 2. Fetch project context (name, description, knowledge base)
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

  if (didSearch && chunks.length === 0) {
    return {
      answer: productContext.length > 0
        ? "I don't have a specific article about that, but I'd be happy to help! Could you rephrase your question or ask about a specific feature?"
        : "I couldn't find relevant information to answer your question. The documentation may not cover this topic yet.",
      sources: [],
      followUps: [],
    }
  }

  // 3. Build context from chunks — enriched with each page's location
  //    in the sidebar hierarchy so Gemini understands how sections relate.
  const pageIndex = chunks.length > 0 ? await buildPageIndex(projectId) : new Map()
  const context = chunks.length > 0 ? buildContextFromChunks(chunks, pageIndex) : ''

  // 4. Build conversation with history
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
    ? `\n\n## About the user you're helping\n${userInfo.join('\n')}\nAddress them by first name if known. If you know which page they're currently viewing, prioritize help related to that page and make your follow-up suggestions relevant to where they are in the app.\n\n### Plan-aware behavior\nThe user's plan is listed above when known (Free / Startup / Growth / Business). If they ask about a capability that requires a higher plan (e.g. more seats, more monthly tokens, widget white-labeling, overage billing on Growth+), don't refuse or hide it. Instead: briefly explain how the feature works, state that it's included on higher plans, and invite them to upgrade from the Plans & usage section. Stay helpful, never pushy.`
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
- If a relevant screenshot URL appears in the Documentation Context, embed ONE per message using markdown image syntax: \`![short caption](https://exact-url-from-context)\`. Put the image on its own line. Never paste a raw URL — it must always be wrapped in \`![...](...)\`. Never truncate or abbreviate the URL (no \`...\`).
- Match the user's language (French → French, English → English)
- When drawing from a specific page in the Documentation Context, cite it inline using Markdown link syntax where the href is the page's slug (the part after the last \`/\` in its path). Example: "Toggle the Published switch on [Publish your documentation](publish-your-documentation) at the top of the page." One citation per distinct page you reference. Never write raw brackets like \`[Page Title]\` without parentheses — it renders as non-clickable text; use \`[Page Title](slug)\` instead. Don't cite if the answer is general.

## Ambiguity handling
- If the user's question could reasonably mean two or more different things AND the correct answer depends on which one, ask a one-line clarifying question instead of guessing. Example: "Do you mean publish a single page, or enable the public docs URL for the whole project?"
- Don't over-clarify — only when the two interpretations would give materially different answers.

## Follow-up suggestions
- After your answer, add a line "---FOLLOWUPS---" then a JSON array of 1-2 short follow-up questions
- These must be specific to what was just discussed — not generic
- Example format:
  ---FOLLOWUPS---
  ["How do I invite team members?", "What are the different plans?"]
- ALWAYS include the ---FOLLOWUPS--- separator and array, even if it's just one question

## Interactive guide flag
- If your answer describes steps the user could perform in their app's UI (clicking buttons, filling forms, navigating pages), add "---WALKTHROUGH---" on its own line BEFORE the ---FOLLOWUPS--- line
- ONLY add this flag when the answer contains concrete UI actions (click, type, select, navigate). Do NOT add it for conceptual explanations, FAQs, or answers that don't involve interacting with the UI
- This flag enables a "Guide me" button that highlights UI elements on the user's screen

## Boundaries
- Base your answers on the documentation context — don't invent features
- Do NOT fabricate screenshot URLs — only use images that appear in the context
- If the docs don't cover something, say so briefly and suggest what to try
- For complex issues beyond the docs, suggest contacting support`

  const contextBlock = context ? `## Documentation Context\n\n${context}\n\n` : ''

  const userPrompt = `${contextBlock}${conversationHistory ? `## Conversation History\n\n${conversationHistory}\n\n` : ''}## User's Question

${message}`

  // Route complex queries to Gemini 2.5 Pro for deeper reasoning. Flash
  // handles 95% of questions fine; Pro shines on "why does X do Y?" and
  // multi-step "how do I combine X with Y?" comparisons. ~3× slower/
  // cost per call but only triggered on a minority.
  const useProModel = isComplexQuery(message)
  const response = await generateText({
    systemPrompt,
    userPrompt,
    maxTokens: 2048,
    // Lower temperature = tighter, more factual answers. 0.3 is the
    // sweet spot for support-style Q&A: still natural, rarely invents.
    temperature: 0.3,
    ...(useProModel ? { model: GEMINI_PRO_MODEL } : {}),
  })

  // Deduplicate sources
  const sourceMap = new Map<string, { pageId: string; pageTitle: string; pageSlug: string }>()
  for (const chunk of chunks) {
    if (!sourceMap.has(chunk.pageSlug)) {
      sourceMap.set(chunk.pageSlug, { pageId: chunk.pageId, pageTitle: chunk.pageTitle, pageSlug: chunk.pageSlug })
    }
  }

  // Parse walkthrough flag and follow-ups from response
  let answer = response.text
  let followUps: string[] = []
  let walkthroughAvailable = false

  // Safety net: Gemini occasionally pastes raw image URLs instead of markdown
  // image syntax. Wrap any bare image URL we find on its own line (or after
  // whitespace) in `![screenshot](url)` so the renderer picks it up.
  answer = wrapBareImageUrls(answer)

  // Resolve relative links → absolute public-docs URLs so widget + MCP +
  // public-docs chat all get clickable citations. Gemini often returns
  // `[Title](./slug)` or `[Title](slug)` from source markdown or as a
  // natural reference; those fail to click in the widget (strips non-http
  // links) and in public-docs chat without a project prefix.
  answer = resolvePublicDocsLinks(answer, projectId, pageIndex)

  // Check for ---WALKTHROUGH--- flag (AI signals this answer is guidable)
  if (/---?\s*WALKTHROUGH\s*---?/i.test(answer)) {
    walkthroughAvailable = true
    answer = answer.replace(/---?\s*WALKTHROUGH\s*---?\n?/gi, '').trim()
  }

  // Parse follow-ups
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
    ...(walkthroughAvailable ? { walkthroughAvailable } : {}),
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

// --- Progressive walkthrough generation (one step at a time) ---

// Cache RAG context — same question always produces same doc chunks
const walkthroughContextCache = new Map<string, { docContext: string; expiresAt: number }>()
const WT_CONTEXT_TTL_MS = 600_000 // 10 minutes

async function getWalkthroughDocContext(projectId: string, message: string): Promise<string> {
  const cacheKey = `${projectId}:${message}`
  const cached = walkthroughContextCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) return cached.docContext

  const queryEmbedding = await embedText(message)
  const chunks = await chatRepo.searchChunks(projectId, queryEmbedding, 10, 0.25)
  const pageIndex = chunks.length > 0 ? await buildPageIndex(projectId) : new Map()
  const docContext = chunks.length > 0 ? buildContextFromChunks(chunks, pageIndex) : ''

  walkthroughContextCache.set(cacheKey, { docContext, expiresAt: Date.now() + WT_CONTEXT_TTL_MS })
  return docContext
}

export async function generateWalkthrough(
  projectId: string,
  request: WalkthroughRequest,
): Promise<WalkthroughResponse> {
  // 1. RAG search (cached — same message always returns same chunks)
  const docContext = await getWalkthroughDocContext(projectId, request.message)

  // 2. Build prompt with completed steps context
  const userPrompt = buildWalkthroughPrompt(
    docContext,
    request.domSnapshot,
    request.message,
    request.completedSteps ?? [],
  )

  const response = await generateText({
    systemPrompt: WALKTHROUGH_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 1024,
  })

  // 3. Parse single-step JSON response (tolerant of Gemini quirks)
  let jsonStr = response.text.trim()
  // Strip markdown fences
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }
  // Extract JSON object if Gemini added text around it
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/)
  if (jsonMatch) jsonStr = jsonMatch[0]

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>
  } catch (parseErr) {
    console.error('[walkthrough] JSON parse failed:', (parseErr as Error).message, '| raw:', jsonStr.slice(0, 300))
    return { done: true, step: null, stepNumber: 0, hint: null }
  }

  // Normalize Gemini output — coerce empty strings to null for nullable fields
  if (parsed.step && typeof parsed.step === 'object') {
    const step = parsed.step as Record<string, unknown>
    if (step.elementRef === '' || step.elementRef === undefined) step.elementRef = null
    if (step.fallbackSelector === '' || step.fallbackSelector === undefined) step.fallbackSelector = null
    if (step.typeValue === '' || step.typeValue === undefined) step.typeValue = null
  }
  if (parsed.hint === '' || parsed.hint === undefined) parsed.hint = null
  if (parsed.stepNumber === undefined) parsed.stepNumber = (request.completedSteps?.length ?? 0) + 1

  try {
    const validated = WalkthroughResponseSchema.parse(parsed)
    return {
      done: validated.done,
      step: validated.step,
      stepNumber: validated.stepNumber,
      hint: validated.hint,
    }
  } catch (zodErr) {
    console.error('[walkthrough] Zod validation failed:', (zodErr as Error).message, '| parsed:', JSON.stringify(parsed).slice(0, 300))
    return { done: true, step: null, stepNumber: 0, hint: null }
  }
}

// Match http(s) URLs that end in a recognizable image extension (with an
// optional query string). Skip URLs that are already inside markdown image or
// link syntax — we only want to catch raw URLs.
const BARE_IMAGE_URL_RE = /(^|[\s(])(https?:\/\/[^\s)]+?\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?[^\s)]*)?)(?=$|[\s)])/gi

function wrapBareImageUrls(text: string): string {
  return text.replace(BARE_IMAGE_URL_RE, (match, prefix: string, url: string, offset: number, full: string) => {
    // Don't wrap if the char immediately before `prefix` is `(` or `]` — that
    // means we're already inside `](...)` or `)(...)` markdown markup.
    const priorIdx = offset - 1
    const prior = priorIdx >= 0 ? full[priorIdx] : ''
    if (prior === ']' || prior === '(') return match
    return `${prefix}![screenshot](${url})`
  })
}

interface PageIndexEntry {
  id: string
  title: string
  slug: string
  parentId: string | null
}

/** Load the project's pages once so buildContextFromChunks can render
 *  hierarchical breadcrumbs ("Getting Started > Create your first project")
 *  without a DB call per chunk. */
async function buildPageIndex(projectId: string): Promise<Map<string, PageIndexEntry>> {
  const { findPagesByProjectId } = await import('../page/page.repository.js')
  const pages = await findPagesByProjectId(projectId)
  const map = new Map<string, PageIndexEntry>()
  for (const p of pages) {
    map.set(p.id, { id: p.id, title: p.title, slug: p.slug, parentId: p.parentId })
  }
  return map
}

function breadcrumbFor(pageId: string, index: Map<string, PageIndexEntry>): string {
  const trail: string[] = []
  let current = index.get(pageId)
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    trail.unshift(current.title)
    current = current.parentId ? index.get(current.parentId) : undefined
  }
  return trail.join(' > ')
}

function buildContextFromChunks(chunks: DocChunk[], pageIndex: Map<string, PageIndexEntry>): string {
  // Group chunks by page for coherent context
  const byPage = new Map<string, DocChunk[]>()
  for (const chunk of chunks) {
    const existing = byPage.get(chunk.pageSlug) ?? []
    existing.push(chunk)
    byPage.set(chunk.pageSlug, existing)
  }

  const sections: string[] = []
  for (const [slug, pageChunks] of byPage) {
    const first = pageChunks[0]!
    const breadcrumb = breadcrumbFor(first.pageId, pageIndex) || first.pageTitle
    // Sort by chunk index for reading order
    pageChunks.sort((a, b) => a.chunkIndex - b.chunkIndex)
    const text = pageChunks.map((c) => c.chunkText).join('\n\n')
    sections.push(`### From "${breadcrumb}" (/${slug})\n\n${text}`)
  }

  return sections.join('\n\n---\n\n')
}

/**
 * Rewrite any relative markdown link in Gemini's answer to a full
 * https://.../docs/<projectId>/<slug> URL whenever the link target
 * looks like (or matches) a page slug we know about. Handles:
 *   [text](./slug) / [text](../slug) / [text](/docs/slug) / [text](slug)
 * Absolute `https?://` links are left untouched.
 *
 * The widget's simpleMarkdown only renders http(s) links — unresolved
 * relative links get stripped to plain text. This function is the
 * single place that makes citations clickable in the widget, public-
 * docs chat, and MCP consumers.
 */
function resolvePublicDocsLinks(
  markdown: string,
  projectId: string,
  pageIndex: Map<string, PageIndexEntry>,
): string {
  // Skip if the public base URL isn't configured — can't build absolute
  // links without it, and half-rewriting would look worse than doing
  // nothing.
  const base = env.PUBLIC_APP_URL ?? ''
  if (!base) return markdown
  if (pageIndex.size === 0) return markdown

  const slugSet = new Set(Array.from(pageIndex.values()).map((p) => p.slug))

  return markdown.replace(/(!?)\[([^\]]+)\]\(([^)]+)\)/g, (match, bang: string, text: string, href: string) => {
    // Keep images + already-absolute links untouched
    if (bang === '!') return match
    if (/^https?:\/\//i.test(href) || href.startsWith('mailto:')) return match

    // Strip relative path prefixes + leading /docs/<projectId>?
    let candidate = href.trim()
    candidate = candidate.replace(/^\.?\.?\//, '')
    candidate = candidate.replace(/^\/docs\/[^/]+\//, '')
    candidate = candidate.replace(/^\/docs\//, '')
    candidate = candidate.replace(/^\//, '')
    // Drop anchor / query to match against slugSet cleanly
    const pure = candidate.split(/[?#]/)[0] ?? ''

    if (!slugSet.has(pure)) return match
    return `[${text}](${base}/docs/${projectId}/${pure})`
  })
}

/**
 * Rerank top-K candidates with Gemini as a relevance judge. Vector
 * similarity captures "similar meaning" but not "answers the question" —
 * rerank picks the chunks that actually address what was asked.
 *
 * Input: the rewritten query + up to 20 candidates.
 * Output: top-N candidates ordered by Gemini's relevance score.
 * Cost: one Flash call, ~500 tokens each way.
 */
async function rerankChunks(query: string, candidates: DocChunk[], keepTop: number): Promise<DocChunk[]> {
  if (candidates.length <= keepTop) return candidates
  const numbered = candidates
    .map((c, i) => `[${i}] (${c.pageTitle}) ${c.chunkText.slice(0, 400)}`)
    .join('\n\n')
  const prompt = `Score each passage from 0-10 on how directly it answers the user's question. Return ONLY a JSON array of {"i": number, "score": number} — no prose, no code fence.

Question: ${query}

Passages:
${numbered}`
  const { text } = await generateText({
    userPrompt: prompt,
    maxTokens: 512,
    temperature: 0,
    json: true,
  })
  const parsed = JSON.parse(text) as { i: number; score: number }[]
  if (!Array.isArray(parsed)) return candidates.slice(0, keepTop)
  const ranked = parsed
    .filter((r) => typeof r.i === 'number' && typeof r.score === 'number' && candidates[r.i])
    .sort((a, b) => b.score - a.score)
    .slice(0, keepTop)
    .map((r) => candidates[r.i]!)
  return ranked.length > 0 ? ranked : candidates.slice(0, keepTop)
}

/** Heuristic: route to Gemini 2.5 Pro when the query looks like it
 *  needs multi-hop reasoning, comparison, or deep explanation. Cheap
 *  keyword check — good enough as a first-pass router. */
function isComplexQuery(message: string): boolean {
  const lower = message.toLowerCase()
  if (message.length > 180) return true
  const signals = [
    'why', 'pourquoi', 'how does', 'comment est-ce que',
    'difference between', 'diff\u00e9rence entre', 'vs ', 'versus ',
    'compare', 'comparer', 'trade-off', 'tradeoff',
    'explain how', 'expliquer comment', 'under the hood',
  ]
  return signals.some((s) => lower.includes(s))
}

/**
 * Rewrite a conversational query into a self-contained question Gemini
 * can embed productively. "et l'autre option?" returns context on its
 * own; with history, we can turn it into "What's the second pricing plan?"
 *
 * Cheap: one Gemini call with small output. Falls back to the original
 * message on any error — never blocks the chat.
 */
async function rewriteQueryWithHistory(message: string, history: ChatMessage[]): Promise<string> {
  const recent = history.slice(-4)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')
  const prompt = `Given this short conversation, rewrite the user's latest message into a fully self-contained question that doesn't depend on prior context. Keep the user's language (French → French, English → English). Return only the rewritten question, nothing else.

${recent}
User (latest): ${message}

Rewritten:`
  const { text } = await generateText({
    userPrompt: prompt,
    maxTokens: 128,
    temperature: 0.1,
  })
  const cleaned = text.trim().replace(/^["']|["']$/g, '')
  return cleaned.length > 0 && cleaned.length < 400 ? cleaned : message
}
