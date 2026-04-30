import { embedText, embedTexts, generateText, generateTextStream } from '../../shared/ai/gemini.client.js'
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

/**
 * Concurrency cap for parallel page indexing. Gemini's embedTexts batch
 * hits ~60 RPM soft-limit on the free tier; 5 concurrent pages × 1
 * embedTexts call each ≈ 5 RPM peak, which leaves headroom for chat
 * traffic to go through at the same time. Previously this loop was
 * sequential, so a 100-page project serialized into a 60-second wall
 * clock — now it's under 15s on the same pool.
 */
const INDEX_CONCURRENCY = 5

export async function indexProject(projectId: string): Promise<number> {
  const { findPagesByProjectId } = await import('../page/page.repository.js')
  const pages = await findPagesByProjectId(projectId)

  const indexable = pages.filter((p) => p.content?.trim())
  if (indexable.length === 0) return 0

  let total = 0
  // Process in fixed-size waves so we cap parallelism without pulling in
  // a queue library. One rejected page doesn't stop the others — we log
  // and keep the project's other pages indexed.
  for (let i = 0; i < indexable.length; i += INDEX_CONCURRENCY) {
    const wave = indexable.slice(i, i + INDEX_CONCURRENCY)
    const results = await Promise.allSettled(
      wave.map((p) => indexPage({
        id: p.id,
        projectId: p.projectId,
        title: p.title,
        slug: p.slug,
        content: p.content,
      })),
    )
    for (const r of results) {
      if (r.status === 'fulfilled') total += r.value
      else console.error('[chat] indexPage failed during indexProject:', r.reason)
    }
  }
  console.log(`[chat] Indexed ${total} total chunks for project ${projectId} (${indexable.length} pages)`)
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
    // Rewrite only when it buys us something — conversational follow-ups
    // (need to resolve "it", "that") or very short queries ("publish?"
    // = too vague for embedding). Otherwise use the raw message and
    // save ~400ms on the round trip.
    const needsRewrite = history.length >= 2 || message.trim().length < 20
    const effectiveQuery = needsRewrite
      ? await rewriteQuery(message, history).catch(() => message)
      : message

    const queryEmbedding = await embedText(effectiveQuery)
    const candidates = await chatRepo.searchChunks(projectId, queryEmbedding, 20, 0.15)

    // Rerank when the candidate pool is large enough to triage. Drops
    // only the clearest noise — users care about quality on vague hits,
    // which is exactly when the pool is big.
    chunks = candidates.length > 0
      ? (candidates.length >= 10
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

  const { buildChatSystemPrompt, buildChatUserPrompt } = await import('../../shared/ai/prompt.builder.js')
  const systemPrompt = buildChatSystemPrompt({ productContext, userContext })
  const userPrompt = buildChatUserPrompt({ context, conversationHistory, message })

  // Flash for everything — Pro routing doubled latency on complex
  // queries for a marginal quality lift. Can reintroduce later per-
  // query if benchmarks show a recurring failure mode.
  const response = await generateText({
    systemPrompt,
    userPrompt,
    maxTokens: 2048,
    // Lower temperature = tighter, more factual answers. 0.3 is the
    // sweet spot for support-style Q&A: still natural, rarely invents.
    temperature: 0.3,
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

// --- Streaming chat ---

export type ChatStreamEvent =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'sources'; items: { pageId: string; pageTitle: string; pageSlug: string }[] }
  | { type: 'followups'; items: string[] }
  | { type: 'walkthrough'; available: boolean }
  | { type: 'done'; fullText: string }
  | { type: 'error'; message: string }

/**
 * Streaming variant of chat() — yields incremental text deltas as Gemini
 * emits them, so the client can render token-by-token. Same retrieval +
 * post-processing as the non-streaming path; the only differences are:
 *
 *   1. We hold back the trailing 30 chars of the assistant text from each
 *      delta until we know it's not the start of a `---FOLLOWUPS---` or
 *      `---WALKTHROUGH---` marker. Those structured trailers must NOT be
 *      shown to the user. Once a marker is detected, streaming stops and
 *      we accumulate the rest into a private buffer.
 *
 *   2. On stream end we run the same wrapBareImageUrls + resolvePublicDocsLinks
 *      transforms as the non-streaming path, then emit `sources` /
 *      `followups` / `walkthrough` / `done` events. The frontend can either
 *      replace the accumulated assistant text with the post-processed
 *      version (clean) or rely on the fact that link/image fixes are
 *      typically a no-op for Gemini's well-formed output.
 */
export async function* chatStream(
  projectId: string,
  message: string,
  history: ChatMessage[],
  userContext?: { name?: string; email?: string; plan?: string; extra?: string; currentUrl?: string },
): AsyncGenerator<ChatStreamEvent> {
  yield { type: 'start' }

  // Same retrieval pipeline as chat()
  let chunks: DocChunk[] = []
  const didSearch = needsDocSearch(message, history)
  if (didSearch) {
    const needsRewrite = history.length >= 2 || message.trim().length < 20
    const effectiveQuery = needsRewrite
      ? await rewriteQuery(message, history).catch(() => message)
      : message
    const queryEmbedding = await embedText(effectiveQuery)
    const candidates = await chatRepo.searchChunks(projectId, queryEmbedding, 20, 0.15)
    chunks = candidates.length > 0
      ? (candidates.length >= 10
          ? await rerankChunks(effectiveQuery, candidates, 5).catch(() => candidates.slice(0, 8))
          : candidates.slice(0, 8))
      : []
  }

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
    const fallback = productContext.length > 0
      ? "I don't have a specific article about that, but I'd be happy to help! Could you rephrase your question or ask about a specific feature?"
      : "I couldn't find relevant information to answer your question. The documentation may not cover this topic yet."
    yield { type: 'delta', text: fallback }
    yield { type: 'sources', items: [] }
    yield { type: 'followups', items: [] }
    yield { type: 'done', fullText: fallback }
    return
  }

  const pageIndex = chunks.length > 0 ? await buildPageIndex(projectId) : new Map()
  const context = chunks.length > 0 ? buildContextFromChunks(chunks, pageIndex) : ''
  const conversationHistory = history
    .slice(-10)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')

  const { buildChatSystemPrompt, buildChatUserPrompt } = await import('../../shared/ai/prompt.builder.js')
  const systemPrompt = buildChatSystemPrompt({ productContext, userContext })
  const userPrompt = buildChatUserPrompt({ context, conversationHistory, message })

  const stream = await generateTextStream({
    systemPrompt,
    userPrompt,
    maxTokens: 2048,
    temperature: 0.3,
  })

  // Marker detection. Gemini emits `---FOLLOWUPS---` and `---WALKTHROUGH---`
  // as trailers on its own lines. We hold back a small tail buffer so we
  // can detect those markers before flushing them to the client.
  const TAIL_HOLD = 30
  let visible = ''            // accumulated text we've emitted as deltas
  let pending = ''            // accumulated text NOT yet emitted (last TAIL_HOLD chars OR everything after a marker hit)
  let markerHit = false       // true once we've seen a trailer marker; stop streaming further text

  const MARKER_RE = /\n?---\s*(?:FOLLOWUPS|WALKTHROUGH)/i

  try {
    for await (const delta of stream.deltas) {
      pending += delta
      if (markerHit) continue
      // Check if pending now contains a marker
      const m = MARKER_RE.exec(pending)
      if (m && m.index !== undefined) {
        const safeText = pending.slice(0, m.index)
        if (safeText) {
          yield { type: 'delta', text: safeText }
          visible += safeText
        }
        // Keep everything from the marker onwards in `pending` for parsing
        pending = pending.slice(m.index)
        markerHit = true
        continue
      }
      // Flush all but the trailing TAIL_HOLD chars (in case marker spans the chunk boundary)
      if (pending.length > TAIL_HOLD) {
        const safeEnd = pending.length - TAIL_HOLD
        const safeText = pending.slice(0, safeEnd)
        yield { type: 'delta', text: safeText }
        visible += safeText
        pending = pending.slice(safeEnd)
      }
    }
    // Stream ended. Flush remaining pending text if no marker was hit.
    if (!markerHit && pending) {
      yield { type: 'delta', text: pending }
      visible += pending
      pending = ''
    }
  } catch (err) {
    yield { type: 'error', message: (err as Error).message }
    return
  }

  // Full text = visible (already streamed) + pending (the trailer block, if any)
  const fullText = visible + pending

  // Apply the same post-processing as the non-streaming chat() so links
  // and bare image URLs render correctly. These transforms are mostly
  // no-ops on well-formed output — the streamed text the user already saw
  // matches what we send below in 99% of cases.
  let answer = visible
  answer = wrapBareImageUrls(answer)
  answer = resolvePublicDocsLinks(answer, projectId, pageIndex)

  // Walkthrough flag (already filtered out of `visible` thanks to the marker hold)
  const walkthroughAvailable = /---?\s*WALKTHROUGH\s*---?/i.test(fullText)

  // Follow-ups: parse from the trailer block we held back
  let followUps: string[] = []
  const followUpSplit = fullText.split(/---?\s*FOLLOWUPS\s*---?/i)
  if (followUpSplit.length > 1) {
    try {
      let jsonStr = followUpSplit[1]!.trim()
      if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const parsed = JSON.parse(jsonStr) as string[]
      if (Array.isArray(parsed)) followUps = parsed.slice(0, 2)
    } catch { /* keep empty */ }
  }

  // Sources (deduped by slug)
  const sourceMap = new Map<string, { pageId: string; pageTitle: string; pageSlug: string }>()
  for (const chunk of chunks) {
    if (!sourceMap.has(chunk.pageSlug)) {
      sourceMap.set(chunk.pageSlug, { pageId: chunk.pageId, pageTitle: chunk.pageTitle, pageSlug: chunk.pageSlug })
    }
  }

  yield { type: 'sources', items: Array.from(sourceMap.values()) }
  yield { type: 'followups', items: followUps }
  if (walkthroughAvailable) yield { type: 'walkthrough', available: true }
  yield { type: 'done', fullText: answer }
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

/**
 * Best-effort repair of a truncated JSON string — Gemini occasionally
 * hits maxTokens mid-output and emits something like
 * `{"done": false, "step": {"instruction": "Click …"`
 * which JSON.parse naturally rejects. We trim any dangling partial key
 * or value, close open strings, then close unbalanced braces / brackets.
 * Not a full JSON5 parser — just enough to salvage the common patterns.
 */
function repairTruncatedJson(input: string): string {
  let s = input.trim()
  // Drop trailing incomplete structures in reverse-precedence order:
  //   - partial "key":"val  (unterminated string value)
  //   - partial "key":        (colon then nothing)
  //   - partial "key          (unterminated key)
  //   - trailing comma
  s = s.replace(/,?\s*"[^"]*"\s*:\s*"[^"]*$/, '')
  s = s.replace(/,?\s*"[^"]*"\s*:\s*$/, '')
  s = s.replace(/,?\s*"[^"]*$/, '')
  s = s.replace(/,\s*$/, '')
  // Close any still-open string (odd number of unescaped quotes)
  const unescapedQuotes = (s.match(/(?<!\\)"/g) ?? []).length
  if (unescapedQuotes % 2 === 1) s += '"'
  // Close unbalanced brackets / braces in insertion order
  const openBrackets = (s.match(/\[/g) ?? []).length - (s.match(/\]/g) ?? []).length
  const openBraces = (s.match(/\{/g) ?? []).length - (s.match(/\}/g) ?? []).length
  s += ']'.repeat(Math.max(0, openBrackets))
  s += '}'.repeat(Math.max(0, openBraces))
  return s
}

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
    // json:true forces Gemini to emit syntactically valid JSON — no
    // more stray prose, no markdown fences. Still cap tokens but
    // bumped higher so the step description + elementRef + explanation
    // don't get truncated mid-string on richer UI snapshots.
    maxTokens: 2048,
    json: true,
    temperature: 0,
  })

  // 3. Parse single-step JSON response (tolerant of Gemini quirks)
  let jsonStr = response.text.trim()
  // Strip markdown fences (defensive — json:true should already prevent this)
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
    // Second chance: repair a truncated string (dangling key, open
    // string, unclosed braces) and try again. Common failure mode when
    // Gemini stops mid-output on large DOM snapshots — we'd rather
    // salvage a partial step than abort the whole walkthrough.
    const repaired = repairTruncatedJson(jsonStr)
    try {
      parsed = JSON.parse(repaired) as Record<string, unknown>
      console.warn('[walkthrough] JSON repaired from truncated output')
    } catch {
      console.error('[walkthrough] JSON parse failed:', (parseErr as Error).message, '| raw:', jsonStr.slice(0, 300))
      return { done: true, step: null, stepNumber: 0, hint: null }
    }
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
    // Last-chance salvage: if the shape is close but missing some
    // required field (e.g. truncated mid-key), try to surface whatever
    // instruction text we do have as a "hint" step with no element to
    // highlight, so the walkthrough continues instead of dying.
    const step = (parsed.step ?? {}) as Record<string, unknown>
    const instruction = typeof step.instruction === 'string' ? step.instruction : null
    if (instruction && instruction.length > 10) {
      console.warn('[walkthrough] Zod failed, degrading to hint-only step:', (zodErr as Error).message)
      return {
        done: false,
        step: null,
        stepNumber: (request.completedSteps?.length ?? 0) + 1,
        hint: instruction,
      }
    }
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
  const prompt = `Score each passage from 0-10 on how directly it answers the user's question. A passage that mentions the topic but doesn't answer scores 3-5. A passage with the actual answer scores 8-10. An unrelated passage scores 0-2. Return ONLY a JSON array of {"i": number, "score": number} — no prose, no code fence.

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
    // Drop clearly-irrelevant passages (< 4/10) even if they'd make the
    // top cut — answer generation is better with 2 great chunks than
    // 5 mediocre ones.
    .filter((r) => r.score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, keepTop)
    .map((r) => candidates[r.i]!)
  return ranked.length > 0 ? ranked : candidates.slice(0, keepTop)
}

/**
 * Rewrite a (possibly ambiguous or conversational) query into a
 * self-contained, embeddable question. Works with or without history:
 *  - With history: resolves deixis ("this", "it", "the other one").
 *  - Standalone: expands terse queries ("publish?" →
 *    "How do I publish documentation in this product?").
 *
 * Short Gemini call, falls back to the original message on any error.
 */
async function rewriteQuery(message: string, history: ChatMessage[]): Promise<string> {
  const recent = history.slice(-4)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')
  const contextBlock = recent ? `Recent conversation:\n${recent}\n\n` : ''
  const prompt = `${contextBlock}Rewrite the following user query into a complete, self-contained question that an embedding model can match against product documentation. Resolve pronouns and implicit references. Expand very short or ambiguous queries. Keep the user's language (French → French, English → English). Return only the rewritten question — no prefix, no quotes, no explanation.

User query: ${message}

Rewritten:`
  const { text } = await generateText({
    userPrompt: prompt,
    maxTokens: 128,
    temperature: 0.1,
  })
  const cleaned = text.trim().replace(/^["']|["']$/g, '')
  return cleaned.length > 0 && cleaned.length < 400 ? cleaned : message
}

